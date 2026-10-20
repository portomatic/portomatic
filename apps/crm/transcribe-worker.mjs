import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {enqueueTranscription,claimJob,heartbeat,saveProgress,failJob,parseDeepgram,finishJob} from './lib/transcription.mjs';
import {gcloud,hashes,describe,md5,uploadJson} from './lib/archive.mjs';
import {loadMediaConfig} from '../../media/scripts/lib/config.mjs';
import {chunkPlan,parseGeminiChunk,parseGemini} from './lib/gemini-transcription.mjs';
import {createLimiter,createSerialQueue} from './lib/concurrency.mjs';

const exec=promisify(execFile),cfg=loadMediaConfig();
// Keep each storage transfer from spawning a CPU-sized Python process pool on
// top of the call/part concurrency controlled here. These do not change gcloud's
// global configuration or the founders' local settings.
process.env.CLOUDSDK_STORAGE_PROCESS_COUNT??='1';
process.env.CLOUDSDK_STORAGE_THREAD_COUNT??='4';
const secretFile=process.env.CRM_DEEPGRAM_KEY_FILE||path.join(import.meta.dirname,'.state/deepgram-api-key');
const selectedJob=process.argv.includes('--job')?process.argv[process.argv.indexOf('--job')+1]:null;
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const once=process.argv.includes('--once');
const concurrency=once?1:Math.max(1,Math.min(8,Number(process.env.CRM_TRANSCRIPTION_CONCURRENCY)||4));
const prepareSlot=createLimiter(Math.min(2,concurrency));
const chunkSlot=createLimiter(2),requestSlot=createLimiter(4);
let running=0,scheduling=false,stopping=false;
process.on('SIGTERM',()=>{stopping=true;if(!running&&!scheduling)process.exit(0);});
async function signed(uri,generation){
  const out=JSON.parse(await gcloud(['storage','sign-url',uri,'--duration=2h',`--query-params=generation=${generation}`,`--region=${cfg.location}`,'--format=json'],{write:true}));
  const find=v=>{if(typeof v==='string'&&v.startsWith('https://')&&/X-Goog-Signature/i.test(v))return v;if(v&&typeof v==='object')for(const x of Object.values(v)){const r=find(x);if(r)return r;}};
  const url=find(out);if(!url)throw new Error('Could not create temporary audio link');return url;
}
async function prepare(job,dir){
  if(job.prepared_audio)return parse(job.prepared_audio);
  const input=path.join(dir,'original'),file=path.join(dir,'audio.flac');
  // Fetch the pinned generation inside GCP; sequential downloads avoid thousands of remote video seeks.
  await gcloud(['storage','cp',`${job.storage_uri}#${job.object_generation}`,input]);
  const sourceHash=await hashes(input);
  if(sourceHash.sha256!==job.source_sha256)throw new Error('Original recording SHA-256 does not match the catalog');
  console.log(JSON.stringify({job:job.job_id,stage:'extracting audio'}));
  await exec('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',input,'-map','0:a:0','-vn','-c:a','flac',file],{timeout:2*60*60*1000,maxBuffer:1024*1024}).catch(()=>{throw new Error('Could not extract the complete audio track from the pinned original');});
  await fs.unlink(input);
  const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file]);
  const duration_ms=Math.round(Number(stdout.trim())*1000),stat=await fs.stat(file);
  if(!(duration_ms>0)||stat.size>2e9)throw new Error('Extracted audio is empty or exceeds the provider file limit');
  const h=await hashes(file),uri=`gs://${cfg.bucket}/crm-transcripts/${job.touchpoint_id}/${job.job_id}/audio.flac`;
  // Runtime identity can create derived files, but cannot overwrite originals.
  await gcloud(['storage','cp','--no-clobber',`--content-md5=${h.md5}`,'--content-type=audio/flac',file,uri]);
  const o=await describe(uri);
  if(Number(o.size)!==stat.size||md5(o)!==h.md5)throw new Error('Derived audio integrity check failed');
  const audio={uri,generation:String(o.generation),sha256:h.sha256,bytes:stat.size,duration_ms,source_uri:job.storage_uri,source_generation:String(job.object_generation),source_sha256:job.source_sha256};
  await saveProgress(job,'prepared_audio',audio);return audio;
}
async function googleResponse(job,audio,dir,signal){
  const plan=chunkPlan(Number(audio.duration_ms)),saved=audio.gemini_chunks||[];
  let local;
  const checkpointWrites=createSerialQueue();
  // Per-job checkpoint writes are serialized so concurrent parts cannot overwrite
  // another part's completed response. Every completion remains resumable.
  const persist=()=>checkpointWrites(()=>saveProgress(job,'prepared_audio',{...audio,gemini_chunks:saved}));
  if(plan.length>1&&plan.some(c=>!saved.find(s=>s.index===c.index&&s.start_ms===c.start_ms&&s.duration_ms===c.duration_ms)?.audio)){
    local=path.join(dir,'full.flac');
    await gcloud(['storage','cp',`${audio.uri}#${audio.generation}`,local]);
    if((await hashes(local)).sha256!==audio.sha256)throw new Error('Prepared audio checksum mismatch');
  }
  const partLimit=createLimiter(2);
  const settled=await Promise.allSettled(plan.map(chunk=>partLimit(async()=>{
    let checkpoint=saved.find(c=>c.index===chunk.index&&c.start_ms===chunk.start_ms&&c.duration_ms===chunk.duration_ms);
    let partAudio=checkpoint?.audio,response;
    if(checkpoint?.artifact){
      response=JSON.parse(await gcloud(['storage','cat',`${checkpoint.artifact.uri}#${checkpoint.artifact.generation}`]));
    }else{
      if(!partAudio){
        if(plan.length===1){partAudio={...audio};delete partAudio.gemini_chunks;}
        else{
          partAudio=await chunkSlot(async()=>{
            const file=path.join(dir,`part-${chunk.index}.flac`);
            await exec('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-ss',String(chunk.start_ms/1000),'-i',local,'-t',String(chunk.duration_ms/1000),'-map','0:a:0','-c:a','flac',file],{maxBuffer:1024*1024});
            const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file]);
            if(Math.abs(Math.round(Number(stdout.trim())*1000)-chunk.duration_ms)>100)throw new Error('Audio chunk extraction was incomplete');
            const h=await hashes(file),stat=await fs.stat(file),uri=`gs://${cfg.bucket}/crm-transcripts/${job.touchpoint_id}/${job.job_id}/part-${chunk.index}.flac`;
            await gcloud(['storage','cp','--no-clobber',`--content-md5=${h.md5}`,'--content-type=audio/flac',file,uri]);
            const obj=await describe(uri);
            if(Number(obj.size)!==stat.size||md5(obj)!==h.md5)throw new Error('Audio chunk integrity check failed');
            const prepared={uri,generation:String(obj.generation),sha256:h.sha256,bytes:stat.size,duration_ms:chunk.duration_ms};
            await fs.unlink(file);return prepared;
          });
        }
        checkpoint={...chunk,audio:partAudio};saved.push(checkpoint);
        await persist();
      }
      const token=(await gcloud(['auth','print-access-token'])).trim();
      // Derived object names are unique per run. Refuse a replaced generation.
      if(String((await describe(partAudio.uri)).generation)!==String(partAudio.generation))throw new Error('Gemini input audio generation changed');
      const url=`https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/locations/global/publishers/google/models/${encodeURIComponent(job.model)}:generateContent`;
      const opts=parse(job.options);
      const body={contents:[{role:'user',parts:[{fileData:{mimeType:'audio/flac',fileUri:partAudio.uri}}]}],generationConfig:{audioTranscriptionConfig:{mode:opts.mode,diarization:opts.diarization,wordTimestamp:opts.wordTimestamp}}};
      console.log(JSON.stringify({job:job.job_id,stage:'Gemini transcription',part:chunk.index+1,parts:plan.length}));
      response=await requestSlot(async()=>{
        const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(11*60000)])});
        if(!r.ok){const err=await r.json().catch(()=>({}));throw new Error(`Gemini request failed (${r.status}): ${String(err.error?.message||'').slice(0,700)}`);}
        return await r.json();
      });
      checkpoint.artifact=await uploadJson(`crm-transcripts/${job.touchpoint_id}/${job.job_id}/part-${chunk.index}-response-{sha}.json`,{...response,portomatic_provenance:{chunk,audio:partAudio,source_audio:audio.uri,source_generation:audio.generation,options:opts}},{write:false});
      await persist();
    }
    parseGeminiChunk(response,chunk,plan.length>1);
    return {...chunk,audio:partAudio,response};
  })));
  // Let siblings persist before cleanup/retry. Never activate a partial recording.
  const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  return {provider:'google',audio_duration_ms:Number(audio.duration_ms),options:parse(job.options),chunks:settled.map(r=>r.value)};
}
async function processJob(job,key){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'crm-transcribe-'));
  const abort=new AbortController();let leaseError;
  const timer=setInterval(()=>heartbeat(job).catch(e=>{leaseError=e;abort.abort();}),60000);
  try{
    let artifact=job.response_artifact&&parse(job.response_artifact),response;
    const audio=await prepareSlot(()=>prepare(job,dir));
    if(leaseError)throw leaseError;
    if(artifact)response=JSON.parse(await gcloud(['storage','cat',`${artifact.uri}#${artifact.generation}`]));
    else if(job.provider==='google'){
      response=await googleResponse(job,audio,dir,abort.signal);
      artifact=await uploadJson(`crm-transcripts/${job.touchpoint_id}/${job.job_id}/response-{sha}.json`,{...response,portomatic_provenance:{audio,model_requested:job.model,options:parse(job.options)}},{write:false});
      await saveProgress(job,'response_artifact',artifact);
    }else if(job.provider==='deepgram'){
      console.log(JSON.stringify({job:job.job_id,stage:'transcribing',audio_bytes:audio.bytes}));
      const url=new URL('https://api.deepgram.com/v1/listen');url.searchParams.set('model',job.model);
      for(const [k,v] of Object.entries(parse(job.options)))url.searchParams.set(k,String(v));
      const timeout=setTimeout(()=>abort.abort(),11*60000);
      try{
        const r=await fetch(url,{method:'POST',headers:{authorization:'Token '+key,'content-type':'application/json'},body:JSON.stringify({url:await signed(audio.uri,audio.generation)}),signal:abort.signal});
        if(!r.ok)throw new Error(`Deepgram request failed (${r.status})`);
        response=await r.json();
      }finally{clearTimeout(timeout);}
      // Archive the original provider response before parsing or SQL import, so retries can resume it.
      artifact=await uploadJson(`crm-transcripts/${job.touchpoint_id}/${job.job_id}/response-{sha}.json`,{...response,portomatic_provenance:{audio,model_requested:job.model,options:parse(job.options)}},{write:false});
      await saveProgress(job,'response_artifact',artifact);
    }else throw new Error('Unsupported transcription provider');
    const result=job.provider==='google'?parseGemini(response,audio.duration_ms):parseDeepgram(response,audio.duration_ms);
    if(leaseError)throw leaseError;
    await heartbeat(job);await finishJob(job,result,artifact);
    console.log(JSON.stringify({job:job.job_id,status:'complete',segments:result.segments.length,duration_ms:result.duration}));
  }finally{clearInterval(timer);await fs.rm(dir,{recursive:true,force:true});}
}
async function run(job){
  try{
    let key;
    if(job.provider==='deepgram'){
      key=process.env.DEEPGRAM_API_KEY;
      if(!key){
        try{key=await fs.readFile(secretFile,'utf8');}
        catch(e){if(e.code!=='ENOENT')throw e;key=await gcloud(['secrets','versions','access','latest','--secret=crm-deepgram-api-key']);}
      }
      key=key.trim();if(!key)throw new Error('Deepgram key is empty');
    }
    console.log(JSON.stringify({job:job.job_id,status:'running',attempt:job.attempts,concurrent_jobs:running}));
    await processJob(job,key);
  }catch(e){console.error(JSON.stringify({job:job.job_id,error:e.message}));await failJob(job,e);}
}
async function tick(){
  if(scheduling||stopping)return;scheduling=true;
  try{
    await enqueueTranscription(null,{automatic:true});
    while(!stopping&&running<concurrency){
      const job=await claimJob(selectedJob);if(!job)break;
      running++;
      void run(job).catch(e=>console.error('Transcription job persistence:',e.message)).finally(()=>{
        running--;
        if(stopping&&!running&&!scheduling)process.exit(0);
        if(!once&&!stopping)setTimeout(()=>void tick(),0);
      });
      if(once)break;
    }
  }catch(e){console.error('Transcription worker:',e.message);}finally{
    scheduling=false;if(stopping&&!running)process.exit(0);
  }
}
console.log(JSON.stringify({worker:'transcription',concurrency,preparation_slots:Math.min(2,concurrency)}));
await tick();
if(!once)setInterval(()=>void tick(),15000);
