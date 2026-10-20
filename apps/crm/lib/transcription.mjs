import {queryRows,executeSql,sqlLiteral as q,sqlValues} from '../../../customers/scripts/lib/db.mjs';
import {uuid} from './store.mjs';

export const provider='google',model='gemini-3.5-transcribe';
export const options={mode:'VERBATIM',diarization:true,wordTimestamp:true,chunk_ms:840000};
const originals=`SELECT t.touchpoint_id,t.storage_uri,coalesce(r.object_generation,a.object_generation) AS generation,coalesce(r.sha256,a.sha256) AS sha256
 FROM crm_touchpoints t LEFT JOIN recording_objects r ON t.source='customer-recording' AND t.external_id=r.recording_id::text
 LEFT JOIN media_archive_assets a ON t.source='media-archive' AND t.external_id=a.asset_id::text AND a.source_kind='original'
 WHERE t.kind='recording' AND t.storage_uri=coalesce(r.storage_uri,a.storage_uri)`;
export async function enqueueTranscription(id,{automatic=false,requestedBy=null}={}){
  const rows=await queryRows(`INSERT INTO crm_transcription_jobs(touchpoint_id,storage_uri,object_generation,source_sha256,provider,model,options,reason,requested_by,prepared_audio)
    SELECT touchpoint_id,storage_uri,generation,sha256,${q(provider)},${q(model)},${q(JSON.stringify(options))}::jsonb,${q(automatic?'automatic':'rerun')},${q(requestedBy)},
      (SELECT j.prepared_audio FROM crm_transcription_jobs j WHERE j.touchpoint_id=src.touchpoint_id AND j.source_sha256=src.sha256 AND j.object_generation=src.generation AND j.prepared_audio IS NOT NULL ORDER BY j.created_at DESC LIMIT 1)
      FROM (${originals}) src
    WHERE generation IS NOT NULL ${id?`AND touchpoint_id=${uuid(id)}`:''}
    ${automatic?`AND NOT EXISTS(SELECT 1 FROM crm_transcription_jobs j WHERE j.touchpoint_id=src.touchpoint_id AND j.provider=${q(provider)} AND j.model=${q(model)} AND j.object_generation=src.generation AND j.status<>'superseded')` :''}
    ON CONFLICT DO NOTHING RETURNING job_id,touchpoint_id,status;`);
  return rows;
}
export async function claimJob(jobId=null){
  await executeSql(`UPDATE crm_transcription_jobs SET status='failed',error='Worker interrupted on final attempt',lease_until=NULL WHERE status='running' AND lease_until<now() AND attempts>=4;`);
  const rows=await queryRows(`WITH next AS (SELECT job_id FROM crm_transcription_jobs WHERE
    (status='queued' AND available_at<=now() OR status='running' AND lease_until<now()) AND attempts<4 ${jobId?`AND job_id=${uuid(jobId)}`:''}
    ORDER BY (reason='rerun') DESC,(SELECT t.occurred_at FROM crm_touchpoints t WHERE t.touchpoint_id=crm_transcription_jobs.touchpoint_id) DESC,(prepared_audio IS NOT NULL) DESC,(SELECT coalesce((t.raw->>'duration_ms')::bigint,0) FROM crm_touchpoints t WHERE t.touchpoint_id=crm_transcription_jobs.touchpoint_id),created_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE crm_transcription_jobs j SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',error=NULL
    FROM next WHERE j.job_id=next.job_id RETURNING j.*;`);
  return rows[0];
}
export async function heartbeat(job){
  const rows=await queryRows(`UPDATE crm_transcription_jobs SET lease_until=now()+interval '5 minutes' WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running' RETURNING job_id;`);
  if(!rows.length)throw new Error('Transcription lease lost');
}
export async function saveProgress(job,field,value){
  if(!['prepared_audio','response_artifact'].includes(field))throw new Error('Invalid progress field');
  const rows=await queryRows(`UPDATE crm_transcription_jobs SET ${field}=${q(JSON.stringify(value))}::jsonb WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running' RETURNING job_id;`);
  if(!rows.length)throw new Error('Transcription lease lost');
}
export async function failJob(job,error){
  await executeSql(`UPDATE crm_transcription_jobs SET status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'queued' END,
    error=${q(String(error.message).slice(0,1000))},available_at=now()+attempts*interval '2 minutes',lease_until=NULL
    WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running';`);
}
export function parseDeepgram(data,expectedDurationMs){
  const duration=Math.round(Number(data.metadata?.duration)*1000);
  if(!Number.isFinite(duration)||duration<=0||!Array.isArray(data.results?.channels)||!data.results.channels.length)throw new Error('Invalid Deepgram response');
  if(expectedDurationMs&&Math.abs(duration-Number(expectedDurationMs))>Math.max(5000,Number(expectedDurationMs)*0.01))throw new Error('Transcription audio duration does not match the full recording');
  const utterances=data.results.utterances;
  if(!Array.isArray(utterances))throw new Error('Deepgram response has no utterances');
  const segments=utterances.map((u,i)=>({sequence:i,start_ms:Math.round(u.start*1000),end_ms:Math.round(u.end*1000),speaker:u.speaker==null?null:`Speaker ${Number(u.speaker)+1}`,transcript:String(u.transcript||''),confidence:u.confidence??null}));
  for(const s of segments){
    if(!Number.isFinite(s.start_ms)||!Number.isFinite(s.end_ms)||s.start_ms<0||s.start_ms>duration||s.end_ms<s.start_ms||s.end_ms>duration+2000||!s.transcript.trim())throw new Error('Invalid transcript segment');
    // Provider frame boundaries can slightly exceed EOF. Preserve raw timing in the archived response.
    s.end_ms=Math.min(s.end_ms,duration);
  }
  // A silent recording may legitimately contain zero utterances; spoken text may not disappear.
  if(!segments.length&&data.results.channels.some(c=>c.alternatives?.[0]?.transcript?.trim()))throw new Error('Missing timestamped speech segments');
  return {duration,segments,modelInfo:{...data.metadata.model_info,diarize_info:data.metadata.diarize_info||null},requestId:data.metadata.request_id};
}
export async function finishJob(job,result,artifact){
  const rows=result.segments.map(s=>[job.job_id,s.sequence,s.start_ms,s.end_ms,s.speaker,s.transcript,s.confidence]);
  // Stage segments in bounded batches; the old current transcript stays active until commit.
  await executeSql(`INSERT INTO crm_transcripts(run_id,touchpoint_id,provider,model,model_info,artifact_uri,artifact_generation,artifact_sha256,audio_duration_ms)
    VALUES(${uuid(job.job_id)},${uuid(job.touchpoint_id)},${q(job.provider)},${q(job.model)},${q(JSON.stringify(result.modelInfo))}::jsonb,${q(artifact.uri)},${q(artifact.generation)},${q(artifact.sha256)},${result.duration}) ON CONFLICT DO NOTHING;`);
  for(let i=0;i<rows.length;i+=250)await executeSql(`INSERT INTO crm_transcript_segments(run_id,sequence,start_ms,end_ms,speaker,transcript,confidence) VALUES ${sqlValues(rows.slice(i,i+250))} ON CONFLICT DO NOTHING;`);
  const text=result.segments.map(s=>`[${Math.floor(s.start_ms/60000)}:${String(Math.floor(s.start_ms/1000)%60).padStart(2,'0')}] ${s.speaker||'Speaker'}: ${s.transcript}`).join('\n');
  await executeSql(`BEGIN;
    SELECT job_id FROM crm_transcription_jobs WHERE job_id=${uuid(job.job_id)} FOR UPDATE;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM crm_transcription_jobs WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running') THEN RAISE EXCEPTION 'Transcription lease lost'; END IF;
    IF (SELECT count(*) FROM crm_transcript_segments WHERE run_id=${uuid(job.job_id)})<>${rows.length} THEN RAISE EXCEPTION 'Incomplete transcript import'; END IF; END $$;
    UPDATE crm_transcripts SET is_current=false WHERE touchpoint_id=${uuid(job.touchpoint_id)} AND is_current;
    UPDATE crm_transcripts SET is_current=true WHERE run_id=${uuid(job.job_id)};
    UPDATE crm_touchpoints SET body=${q(text)},raw=raw||jsonb_build_object('transcript_status','complete','transcript_run_id',${q(job.job_id)},'transcript_provider',${q(job.provider)},'duration_ms',${result.duration}),ends_at=occurred_at+${result.duration}*interval '1 millisecond',updated_at=now() WHERE touchpoint_id=${uuid(job.touchpoint_id)};
    UPDATE crm_transcription_jobs SET status='complete',finished_at=now(),lease_until=NULL,error=NULL WHERE job_id=${uuid(job.job_id)};
    COMMIT;`);
}
