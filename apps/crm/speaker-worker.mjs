import fs from 'node:fs/promises';
import path from 'node:path';
import {stateDir} from './lib/config.mjs';
import {resolveSpeakerModel} from './lib/openai.mjs';
import {createSpeakerRequest} from './lib/speaker-inference.mjs';
import {enqueueSpeakerJobs,claimSpeakerJob,heartbeatSpeaker,failSpeakerJob,speakerInput,lookupSpeakerContext,finishSpeakerJob} from './lib/speakers.mjs';
import {runSpeakerAgent} from './lib/speaker-agent.mjs';
import {createVideoReader} from './lib/speaker-video.mjs';
import {createLimiter} from './lib/concurrency.mjs';
import {uploadJson} from './lib/archive.mjs';

process.env.CLOUDSDK_STORAGE_PROCESS_COUNT??='1';
process.env.CLOUDSDK_STORAGE_THREAD_COUNT??='4';
const once=process.argv.includes('--once'),jobId=process.argv.includes('--job')?process.argv[process.argv.indexOf('--job')+1]:null;
const concurrency=once?1:Math.max(1,Math.min(6,Number(process.env.CRM_SPEAKER_CONCURRENCY)||3)),frameSlot=createLimiter(2);
let running=0,scheduling=false,stopping=false,lastEnqueue=0,activeModel=null;
process.on('SIGTERM',()=>{stopping=true;if(!running&&!scheduling)process.exit(0);});
async function processJob(job){
  const dir=path.join(stateDir,'speaker-work',job.job_id);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const controller=new AbortController();
  let heartbeatBusy=false;
  const timer=setInterval(async()=>{if(heartbeatBusy)return;heartbeatBusy=true;try{await heartbeatSpeaker(job);}catch(error){controller.abort(error);}finally{heartbeatBusy=false;}},60000);
  try{
    const input=await speakerInput(job),video=await createVideoReader(job,input,dir,frameSlot);
    input.video_observation={status:input.recording.has_video?'screenshots_available_via_read_video_frames':'audio-only'};
    console.log(JSON.stringify({job:job.job_id,stage:'reasoning',turns:input.segments.length,model:job.model}));
    const inference=await createSpeakerRequest();
    const analysis=await runSpeakerAgent(input,{model:job.model,request:inference.request,signal:controller.signal,
      lookupContext:query=>lookupSpeakerContext(job,query),readVideoText:video.read,readVideoFrames:video.readFrames,
      onResponse:async({round,response})=>{
        console.log(JSON.stringify({job:job.job_id,stage:'agent response',round,tool_calls:response.output?.filter(o=>o.type==='function_call').map(o=>o.name)||[]}));
        // Keep each completed provider response before any later tool/API step.
        await uploadJson(`crm-speakers/${input.recording.id}/${job.job_id}/response-${round}-{sha}.json`,response,{write:false});
      }});
    const artifact=await uploadJson(`crm-speakers/${input.recording.id}/${job.job_id}/analysis-{sha}.json`,{
      policy_version:analysis.policy_version,input_hash:job.input_hash,transcript_run_id:job.run_id,input,
      sources:analysis.sources,result:analysis.result,assignments:analysis.assignments,
      requested_model:job.model,model:analysis.model,inference:{backend:inference.config.backend,reasoning_effort:inference.config.reasoning_effort},responses:analysis.responses,tool_calls:analysis.toolCalls,video_context:video.snapshot()
    },{write:false});
    await finishSpeakerJob(job,analysis,artifact,video.snapshot());
    console.log(JSON.stringify({job:job.job_id,stage:'complete',model:analysis.model,named_turns:analysis.assignments.length,total_turns:input.segments.length,names:[...new Set(analysis.assignments.map(a=>a.name))]}));
  }catch(error){
    await failSpeakerJob(job,error);console.error(JSON.stringify({job:job.job_id,error:error.message}));
    if(once)process.exitCode=1;
  }finally{clearInterval(timer);await fs.rm(dir,{recursive:true,force:true});}
}
async function tick(){
  if(scheduling||stopping)return;scheduling=true;
  try{
    if(!jobId&&Date.now()-lastEnqueue>60000){const resolved=await resolveSpeakerModel();activeModel=resolved.model;await enqueueSpeakerJobs({model:resolved.model});lastEnqueue=Date.now();}
    while(!stopping&&running<concurrency){
      const job=await claimSpeakerJob(jobId,{model:activeModel});if(!job)break;
      if(once){await processJob(job);return;}
      running++;void processJob(job).catch(error=>console.error('Speaker worker:',error.message)).finally(()=>{running--;if(stopping&&!running)process.exit(0);void tick();});
    }
  }catch(error){console.error('Speaker scheduler:',error.message);if(once)process.exitCode=1;}
  finally{scheduling=false;}
}
console.log(JSON.stringify({worker:'speaker-agent',concurrency,model_policy:process.env.CRM_SPEAKER_MODEL||'latest-luna'}));
await tick();
if(!once)setInterval(()=>void tick(),10000);
