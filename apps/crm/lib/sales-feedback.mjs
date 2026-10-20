import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {queryRows,executeSql,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';
import {uuid} from './store.mjs';
import {stateDir} from './config.mjs';
import {uploadJson} from './archive.mjs';
import {SALES_POLICY,classifySalesCall,literalTranscript} from './sales-classifier.mjs';
import {speakerContexts} from './speakers.mjs';
const exec=promisify(execFile),parse=v=>typeof v==='string'?JSON.parse(v):v;
export function parseYcJson(text){
  try{return JSON.parse(text);}catch{const start=text.indexOf('{');if(start>=0)return JSON.parse(text.slice(start));throw Error('YC did not return JSON');}
}
export function ycReport(value){
  const report=value?.report||value;
  if(!report||!(typeof report.id==='string'||Number.isSafeInteger(report.id))||!/^[a-zA-Z0-9_-]{1,200}$/.test(String(report.id))||!['submitted','analyzing','complete','failed'].includes(report.status))throw Error('Invalid YC report receipt');
  return {...report,id:String(report.id)};
}
export function feedbackText(feedback,depth=0){
  if(depth>10)return '[Nested content omitted]';
  if(feedback===null||feedback===undefined)return '';
  if(typeof feedback!=='object')return String(feedback);
  if(Array.isArray(feedback))return feedback.map(v=>'- '+feedbackText(v,depth+1)).join('\n');
  return Object.entries(feedback).map(([key,value])=>key.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase())+'\n'+feedbackText(value,depth+1)).join('\n\n');
}
export async function enqueueSalesFeedback(recordingId=null){
  return queryRows(`INSERT INTO crm_sales_feedback_jobs(run_id,policy_version)
    SELECT tr.run_id,${q(SALES_POLICY)} FROM crm_transcripts tr WHERE tr.is_current
    AND (EXISTS(SELECT 1 FROM crm_speaker_jobs s WHERE s.run_id=tr.run_id AND s.is_current AND s.status='complete') OR tr.created_at<now()-interval '10 minutes')
    ${recordingId?`AND tr.touchpoint_id=${uuid(recordingId)}`:''}
    ON CONFLICT DO NOTHING RETURNING job_id,run_id,status;`);
}
export async function salesFeedbackStatus(recordingId=null){
  return queryRows(`SELECT j.job_id,tr.touchpoint_id,t.title,j.status,j.phase,j.decision,j.report_id,j.error,j.finished_at
    FROM crm_sales_feedback_jobs j JOIN crm_transcripts tr USING(run_id) JOIN crm_touchpoints t USING(touchpoint_id)
    WHERE tr.is_current ${recordingId?`AND t.touchpoint_id=${uuid(recordingId)}`:''} ORDER BY t.occurred_at DESC;`);
}
export async function salesFeedbackReport(recordingId){
  const rows=await queryRows(`SELECT t.title,j.status,j.decision,j.report,j.report_artifact,j.report_id FROM crm_sales_feedback_jobs j JOIN crm_transcripts tr USING(run_id) JOIN crm_touchpoints t USING(touchpoint_id) WHERE tr.is_current AND tr.touchpoint_id=${uuid(recordingId)} ORDER BY j.created_at DESC LIMIT 1`);
  return rows[0]?Object.fromEntries(Object.entries(rows[0]).map(([k,v])=>[k,['decision','report','report_artifact'].includes(k)?parse(v):v])):null;
}
export async function claimSalesFeedback(jobId=null){
  const rows=await queryRows(`WITH next AS (SELECT j.job_id FROM crm_sales_feedback_jobs j JOIN crm_transcripts tr USING(run_id) JOIN crm_touchpoints t USING(touchpoint_id)
    WHERE tr.is_current AND ((j.status IN ('queued','polling') AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<now()))
    ${jobId?`AND j.job_id=${uuid(jobId)}`:''} ORDER BY t.occurred_at DESC,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
    UPDATE crm_sales_feedback_jobs j SET status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1
    FROM next WHERE j.job_id=next.job_id RETURNING j.*;`);
  return rows[0];
}
async function update(job,sets){
  const rows=await queryRows(`UPDATE crm_sales_feedback_jobs SET ${sets} WHERE job_id=${uuid(job.job_id)} AND lease_token=${uuid(job.lease_token)} AND status='running' RETURNING job_id`);
  if(!rows.length)throw Error('Sales feedback lease lost');
}
export async function runYc(args){
  try{const {stdout}=await exec(process.env.CRM_YC_BIN||'yc',['sales-feedback',...args,'--json'],{timeout:60000,maxBuffer:16*1024*1024});return parseYcJson(stdout);}
  catch(error){
    // YC intentionally exits nonzero for terminal failed reports, while still
    // returning a valid JSON receipt. Keep that state instead of retrying it.
    try{const value=parseYcJson(String(error.stdout||''));ycReport(value);return value;}catch{}
    throw Error('YC '+args[0]+' failed (exit '+String(error.code||'unknown')+')');
  }
}
export async function uploadWithReceipt(file,receipt){
  const handle=await fs.open(receipt,'w',0o600);let timer;
  try{
    await new Promise((resolve,reject)=>{
      const child=spawn(process.env.CRM_YC_BIN||'yc',['sales-feedback','upload',file,'--json'],{stdio:['ignore',handle.fd,'ignore']});
      timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('YC upload timed out; checking saved receipt before any retry'));},60000);
      child.on('error',()=>reject(Error('YC upload could not start')));child.on('close',code=>code===0?resolve():reject(Error('YC upload did not succeed')));
    });
  }finally{clearTimeout(timer);await handle.sync();await handle.close();}
}
export async function processSalesFeedback(job){
  const dir=path.join(stateDir,'sales-feedback',job.job_id);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const receipt=path.join(dir,'upload-receipt.json');let busy=false;
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{await update(job,"lease_until=now()+interval '3 minutes'");}catch{}finally{busy=false;}},60000);
  try{
    console.log(JSON.stringify({job:job.job_id,stage:job.phase}));
    if(job.phase==='classify'){
      const recording=(await queryRows(`SELECT tr.run_id,t.touchpoint_id,t.title,t.occurred_at FROM crm_transcripts tr JOIN crm_touchpoints t USING(touchpoint_id) WHERE tr.run_id=${uuid(job.run_id)}`))[0];
      const segments=await queryRows(`SELECT sequence,start_ms,speaker,transcript,inferred_name,name_confidence,name_reason FROM crm_named_transcript_segments WHERE run_id=${uuid(job.run_id)} ORDER BY sequence`);
      const transcript=literalTranscript(recording,segments);
      if(transcript.length>1500000)throw Error('Complete transcript exceeds classification input budget');
      const file=path.join(dir,`crm-${job.run_id}.txt`);await fs.writeFile(file,transcript,{mode:0o600});
      const context=(await speakerContexts(recording.touchpoint_id))[0];
      const speakers=[...new Map(segments.filter(s=>s.inferred_name).map(s=>[s.speaker+'|'+s.inferred_name,{speaker:s.speaker,inferred_name:s.inferred_name,confidence:s.name_confidence,reason:s.name_reason}])).values()];
      const analysis=await classifySalesCall({recording,transcript,context,speaker_inferences:speakers,warning:'Speaker names are contextual inferences. Original labels and spoken text are authoritative; calendar/candidate context alone does not prove attendance.'});
      const {request,response,...decision}=analysis;
      console.log(JSON.stringify({job:job.job_id,stage:'classified',category:decision.category,eligible:decision.eligible}));
      const artifact=await uploadJson(`crm-sales-feedback/${job.run_id}/${job.job_id}/decision-{sha}.json`,{policy_version:SALES_POLICY,request,response,decision},{write:false});
      await update(job,`transcript_sha256=${q(crypto.createHash('sha256').update(transcript).digest('hex'))},decision=${q(JSON.stringify(decision))}::jsonb,decision_artifact=${q(JSON.stringify(artifact))}::jsonb,phase='upload',error=NULL${decision.eligible?'':",status='skipped',finished_at=now(),lease_until=NULL"}`);
      if(!decision.eligible){console.log(JSON.stringify({job:job.job_id,status:'skipped',category:decision.category}));return;}
      job.phase='upload';
    }
    if(job.phase==='upload'||job.phase==='uploading'){
      let report;
      try{report=ycReport(parseYcJson(await fs.readFile(receipt,'utf8')));}catch{}
      if(!report&&job.phase==='uploading'){
        // An upload can succeed remotely before a process dies locally. Recover
        // by the exact transcript-version marker; never blindly upload again.
        const list=await runYc(['list']);
        const marker=`CRM transcript version: ${job.run_id}`;
        const candidates=(list.reports||[]).filter(r=>JSON.stringify(r).includes(marker));
        if(candidates.length===1)report=ycReport(candidates[0]);
        else throw Error('YC upload outcome uncertain; duplicate upload prevented');
      }
      if(!report){
        const file=path.join(dir,`crm-${job.run_id}.txt`);
        await fs.access(file);
        await update(job,"phase='uploading'");job.phase='uploading';
        try{await uploadWithReceipt(file,receipt);}catch(error){
          try{report=ycReport(parseYcJson(await fs.readFile(receipt,'utf8')));}catch{throw error;}
        }
        report??=ycReport(parseYcJson(await fs.readFile(receipt,'utf8')));
      }
      await update(job,`report_id=${q(report.id)},report=${q(JSON.stringify(report))}::jsonb,phase='poll',error=NULL`);
      job.report_id=report.id;job.phase='poll';
    }
    if(job.phase==='poll'){
      const report=ycReport(await runYc(['get',job.report_id]));
      if(report.status==='failed'){
        await update(job,`status='failed',report=${q(JSON.stringify(report))}::jsonb,error='YC report analysis failed',finished_at=now(),lease_until=NULL`);return;
      }
      if(report.status!=='complete'){
        await update(job,`status='polling',report=${q(JSON.stringify(report))}::jsonb,attempts=0,available_at=now()+interval '30 seconds',lease_until=NULL,error=NULL`);return;
      }
      if(!report.feedback||!Object.keys(report.feedback).length)throw Error('YC completed without feedback');
      const artifact=await uploadJson(`crm-sales-feedback/${job.run_id}/${job.job_id}/report-{sha}.json`,report,{write:false});
      await update(job,`status='complete',report=${q(JSON.stringify(report))}::jsonb,report_artifact=${q(JSON.stringify(artifact))}::jsonb,finished_at=now(),lease_until=NULL,error=NULL`);
      console.log(JSON.stringify({job:job.job_id,status:'complete',report_id:report.id}));
    }
  }catch(error){
    // Keep upload ambiguity distinct from safe classification/get retries.
    await update(job,`status=CASE WHEN phase='uploading' OR attempts>=4 THEN 'failed' ELSE 'queued' END,error=${q(String(error.message).slice(0,500))},available_at=now()+interval '1 minute',lease_until=NULL`).catch(()=>{});
    console.error(JSON.stringify({job:job.job_id,error:String(error.message).slice(0,500)}));
  }finally{clearInterval(timer);}
}
