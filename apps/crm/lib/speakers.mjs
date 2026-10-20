import crypto from 'node:crypto';
import {queryRows,executeSql,sqlLiteral as q,sqlValues} from '../../../customers/scripts/lib/db.mjs';
import {uuid} from './store.mjs';
import {SPEAKER_POLICY} from './speaker-agent.mjs';
export const parsed=v=>typeof v==='string'?JSON.parse(v):v;
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

export async function speakerContexts(recordingId=null){
  const rows=await queryRows(`SELECT tr.run_id,t.touchpoint_id,t.title,t.occurred_at,t.ends_at,t.storage_uri,
    tj.object_generation,tj.source_sha256,tr.audio_duration_ms,m.name AS uploader_name,m.email AS uploader_email,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.person_id,'name',p.name,'company',p.company,'role',tp.role,
      'emails',(SELECT jsonb_agg(e.email ORDER BY e.email) FROM crm_person_emails e WHERE e.person_id=p.person_id)) ORDER BY p.person_id)
      FROM crm_touchpoint_people tp JOIN crm_people p USING(person_id) WHERE tp.touchpoint_id=t.touchpoint_id),'[]') AS people,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',mt.touchpoint_id,'title',mt.title,'occurred_at',mt.occurred_at,'ends_at',mt.ends_at,
      'body',mt.body,'raw',mt.raw,'association_status',l.status,'association_evidence',l.evidence,
      'people',(SELECT jsonb_agg(jsonb_build_object('name',p.name,'company',p.company,'role',tp.role) ORDER BY p.person_id)
        FROM crm_touchpoint_people tp JOIN crm_people p USING(person_id) WHERE tp.touchpoint_id=mt.touchpoint_id)) ORDER BY mt.touchpoint_id)
      FROM crm_links l JOIN crm_touchpoints mt ON mt.touchpoint_id=l.meeting_id WHERE l.recording_id=t.touchpoint_id AND l.status IN ('automatic','confirmed')),'[]') AS meetings,
    (SELECT jsonb_agg(jsonb_build_object('name',name,'email',email) ORDER BY member_id) FROM crm_members) AS founder_candidates
    FROM crm_transcripts tr JOIN crm_touchpoints t USING(touchpoint_id)
    JOIN crm_transcription_jobs tj ON tj.job_id=tr.run_id LEFT JOIN crm_members m ON m.member_id=t.owner_id
    WHERE tr.is_current ${recordingId?`AND t.touchpoint_id=${uuid(recordingId)}`:''} ORDER BY t.occurred_at DESC;`);
  return rows.map(r=>({...r,people:parsed(r.people)||[],meetings:parsed(r.meetings)||[],founder_candidates:parsed(r.founder_candidates)||[]}));
}
export async function enqueueSpeakerJobs({recordingId=null,model,force=false}={}){
  if(!model)throw new Error('Resolve the speaker model before enqueueing');
  const contexts=await speakerContexts(recordingId),values=contexts.map(c=>[c.run_id,digest(c),JSON.stringify(c),SPEAKER_POLICY,model,force?crypto.randomUUID():'']);
  if(!values.length)return [];
  return await queryRows(`INSERT INTO crm_speaker_jobs(run_id,input_hash,input_snapshot,policy_version,model,rerun_key)
    VALUES ${values.map(row=>`(${row.map((v,i)=>q(v)+(i===2?'::jsonb':'')).join(',')})`).join(',')}
    ON CONFLICT DO NOTHING RETURNING job_id,run_id,model,status;`);
}
export async function claimSpeakerJob(jobId=null,{model=null}={}){
  await executeSql(`UPDATE crm_speaker_jobs SET status='failed',error='Speaker worker interrupted on final attempt',lease_until=NULL WHERE status='running' AND lease_until<now() AND attempts>=4;`);
  const rows=await queryRows(`WITH next AS (SELECT j.job_id FROM crm_speaker_jobs j JOIN crm_transcripts tr USING(run_id)
    WHERE tr.is_current AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<now())) AND j.attempts<4
    ${jobId?`AND j.job_id=${uuid(jobId)}`:model?`AND j.model=${q(model)} AND j.policy_version=${q(SPEAKER_POLICY)}`:''} ORDER BY j.created_at DESC,j.input_snapshot->>'occurred_at' DESC,j.job_id FOR UPDATE OF j SKIP LOCKED LIMIT 1)
    UPDATE crm_speaker_jobs j SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',error=NULL
    FROM next WHERE j.job_id=next.job_id RETURNING j.*;`);
  return rows[0];
}
export async function heartbeatSpeaker(job){
  const rows=await queryRows(`UPDATE crm_speaker_jobs SET lease_until=now()+interval '5 minutes' WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running' RETURNING job_id;`);
  if(!rows.length)throw new Error('Speaker job lease lost');
}
export async function failSpeakerJob(job,error){
  await executeSql(`UPDATE crm_speaker_jobs SET status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'queued' END,error=${q(String(error.message).slice(0,1000))},available_at=now()+attempts*interval '2 minutes',lease_until=NULL WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running';`);
}
export async function speakerInput(job){
  const c=parsed(job.input_snapshot);
  const segments=(await queryRows(`SELECT sequence,start_ms,end_ms,speaker,transcript FROM crm_transcript_segments WHERE run_id=${uuid(job.run_id)} ORDER BY sequence;`)).map(s=>({...s,sequence:Number(s.sequence),start_ms:Number(s.start_ms),end_ms:Number(s.end_ms)}));
  const sources=[{id:'recording',text:JSON.stringify({title:c.title,occurred_at:c.occurred_at,uploader_name:c.uploader_name,uploader_email:c.uploader_email,warning:'Uploader is not necessarily a speaker.'})},
    {id:'founder-candidates',text:JSON.stringify({candidates:c.founder_candidates,warning:'Candidate list only; presence is not established.'})},
    ...c.people.map(p=>({id:'person:'+p.id,text:JSON.stringify(p)})),
    ...c.meetings.map(m=>({id:'meeting:'+m.id,text:JSON.stringify(m)}))];
  return {recording:{id:c.touchpoint_id,title:c.title,occurred_at:c.occurred_at,duration_ms:Number(c.audio_duration_ms),has_video:/\.(mov|mp4|webm|mkv)(?:$|\?)/i.test(c.title+' '+c.storage_uri)},sources,segments};
}
export async function lookupSpeakerContext(job,query){
  if(typeof query!=='string'||query.trim().length<3||query.length>160)throw new Error('Use a specific search phrase of 3–160 characters');
  const c=parsed(job.input_snapshot),terms=contextSearchTerms(query);
  const patterns=terms.map(t=>q('%'+t.replace(/[\\%_]/g,'\\$&')+'%'));
  const matches=column=>'('+patterns.map(p=>`${column} ILIKE ${p}`).join(' OR ')+')';
  const rank=column=>'('+patterns.map(p=>`CASE WHEN ${column} ILIKE ${p} THEN 1 ELSE 0 END`).join('+')+')';
  // One read instead of three SQL round trips per tool invocation. Keyword lists
  // are supported; requiring the entire generated sentence to match lost context.
  const sources=await queryRows(`WITH history AS (
    SELECT 'context:'||t.touchpoint_id AS id,jsonb_build_object('kind',t.kind,'title',t.title,'occurred_at',t.occurred_at,'body',left(t.body,3500),'body_truncated',length(t.body)>3500,
      'people',(SELECT jsonb_agg(jsonb_build_object('name',p.name,'company',p.company,'role',tp.role)) FROM crm_touchpoint_people tp JOIN crm_people p USING(person_id) WHERE tp.touchpoint_id=t.touchpoint_id),
      'warning','Related context, not proof of attendance.')::text AS text
    FROM crm_touchpoints t WHERE t.kind IN ('meeting','email','document','note','message')
    AND t.occurred_at BETWEEN ${q(c.occurred_at)}::timestamptz-interval '120 days' AND ${q(c.occurred_at)}::timestamptz+interval '14 days'
    AND (${matches('t.title')} OR ${matches('t.body')})
    ORDER BY ${rank('t.title')}*3+${rank('t.body')} DESC,abs(extract(epoch FROM t.occurred_at-${q(c.occurred_at)}::timestamptz)),t.touchpoint_id LIMIT 6
  ), contacts AS (
    SELECT 'contact:'||p.person_id AS id,jsonb_build_object('name',p.name,'company',p.company,'position',p.position,'warning','Contact candidate, not proof of attendance.')::text AS text
    FROM crm_people p WHERE p.merged_into IS NULL AND (${matches('p.name')} OR ${matches('p.company')})
    ORDER BY ${rank('p.name')}*2+${rank('p.company')} DESC,p.name,p.person_id LIMIT 8
  ), passages AS (
    SELECT 'related-turn:'||tr.run_id||':'||s.sequence AS id,jsonb_build_object('title',t.title,'occurred_at',t.occurred_at,'speaker',s.speaker,'transcript',left(s.transcript,6000),'transcript_truncated',length(s.transcript)>6000,
      'warning','Other recording with original anonymous labels. Speaker numbers never transfer between recordings.')::text AS text
    FROM crm_transcript_segments s JOIN crm_transcripts tr USING(run_id) JOIN crm_touchpoints t USING(touchpoint_id)
    WHERE tr.is_current AND t.touchpoint_id<>${uuid(c.touchpoint_id)} AND ${matches('s.transcript')}
    ORDER BY ${rank('s.transcript')} DESC,t.occurred_at DESC,s.sequence LIMIT 8
  ) SELECT * FROM history UNION ALL SELECT * FROM contacts UNION ALL SELECT * FROM passages;`);
  return {query,terms,sources};
}
export function contextSearchTerms(query){
  const stop=new Set(['the','and','for','with','conversation','conversations','founder','founders','customer','call','calls','context','about']);
  const words=(query.match(/[\p{L}\p{N}@.-]+/gu)||[]).map(w=>w.replace(/^\.+|\.+$/g,''));
  const terms=[...new Set(words.filter(w=>w.length>=3&&!stop.has(w.toLowerCase())).map(w=>w.toLowerCase()))].slice(0,12);
  return terms.length?terms:[query.trim()];
}
export async function finishSpeakerJob(job,analysis,artifact,videoContext){
  for(let i=0;i<analysis.assignments.length;i+=250){
    const rows=analysis.assignments.slice(i,i+250).map(a=>[job.job_id,job.lease_token,job.run_id,a.sequence,a.name,a.confidence,a.reason,JSON.stringify(a.evidence)]);
    await executeSql(`INSERT INTO crm_speaker_assignments(job_id,lease_token,run_id,sequence,name,confidence,reason,evidence) VALUES ${sqlValues(rows)} ON CONFLICT DO NOTHING;`);
  }
  await executeSql(`BEGIN;
    SELECT run_id FROM crm_transcripts WHERE run_id=${uuid(job.run_id)} FOR UPDATE;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM crm_speaker_jobs WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running') THEN RAISE EXCEPTION 'Speaker job lease lost'; END IF;
    IF (SELECT count(*) FROM crm_speaker_assignments WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)})<>${analysis.assignments.length} THEN RAISE EXCEPTION 'Incomplete speaker attribution import'; END IF; END $$;
    UPDATE crm_speaker_jobs SET is_current=false WHERE run_id=${uuid(job.run_id)} AND is_current AND created_at<=${q(job.created_at)}::timestamptz;
    UPDATE crm_speaker_jobs SET status='complete',result=${q(JSON.stringify({result:analysis.result,model:analysis.model,usage:analysis.responses.map(r=>r.usage),inference:analysis.responses.map(r=>r.portomatic_inference||{backend:'openai'})}))}::jsonb,
      artifact=${q(JSON.stringify(artifact))}::jsonb,video_context=${q(JSON.stringify(videoContext))}::jsonb,
      is_current=NOT EXISTS(SELECT 1 FROM crm_speaker_jobs newer WHERE newer.run_id=${uuid(job.run_id)} AND newer.is_current AND newer.created_at>${q(job.created_at)}::timestamptz),
      finished_at=now(),lease_until=NULL,error=NULL WHERE job_id=${uuid(job.job_id)};
    COMMIT;`);
}
export async function speakerStatus(){return await queryRows(`SELECT j.job_id,t.touchpoint_id,t.title,j.model,j.status,j.attempts,j.error,j.is_current,j.finished_at,
  (SELECT count(*) FROM crm_speaker_assignments a WHERE a.job_id=j.job_id AND a.lease_token=j.lease_token) AS named_turns,
  (SELECT count(*) FROM crm_transcript_segments s WHERE s.run_id=j.run_id) AS total_turns FROM crm_speaker_jobs j JOIN crm_transcripts tr USING(run_id) JOIN crm_touchpoints t USING(touchpoint_id) WHERE tr.is_current ORDER BY j.created_at DESC;`);}
