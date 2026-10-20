import fs from 'node:fs/promises';
import path from 'node:path';
import {stateDir} from './config.mjs';

export async function openaiKey(){
  if(process.env.OPENAI_API_KEY)return process.env.OPENAI_API_KEY.trim();
  if(process.env.CRM_OPENAI_KEY_FILE)return (await fs.readFile(process.env.CRM_OPENAI_KEY_FILE,'utf8')).trim();
  // Reuse the existing local CRM credential reference; never copy its value into
  // settings, logs, model inputs, or customer artifacts.
  const config=JSON.parse(await fs.readFile(path.join(stateDir,'imessage/api-config.json'),'utf8'));
  if(config.key_file)return (await fs.readFile(config.key_file,'utf8')).trim();
  if(config.env_file&&config.variable){
    const key=config.variable.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const match=(await fs.readFile(config.env_file,'utf8')).match(new RegExp('^\\s*(?:export\\s+)?'+key+'\\s*=\\s*(.*)$','m'));
    if(match)return match[1].trim().replace(/^(['"])(.*)\1$/,'$2');
  }
  throw new Error('CRM OpenAI API credential is not configured');
}
export async function openaiRequest(resource,body,{key,signal}={}){
  const response=await fetch('https://api.openai.com/v1/'+resource,{
    method:body?'POST':'GET',headers:{authorization:'Bearer '+(key||await openaiKey()),'content-type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000)
  });
  const data=await response.json();
  if(!response.ok)throw new Error(`OpenAI ${resource} failed (${response.status}): ${String(data.error?.message||'request rejected').slice(0,600)}`);
  return data;
}
export function newestLuna(models){
  // Canonical versioned Luna names only. Never select a different price tier,
  // preview, dated snapshot, or the newest model of an unrelated family.
  const candidates=models.map(m=>typeof m==='string'?m:m.id).filter(id=>/^gpt-\d+(?:\.\d+){0,2}-luna$/.test(id));
  return candidates.sort((a,b)=>{
    const x=a.slice(4,-5).split('.').map(Number),y=b.slice(4,-5).split('.').map(Number);
    for(let i=0;i<Math.max(x.length,y.length);i++){const d=(y[i]||0)-(x[i]||0);if(d)return d;}
    return a.localeCompare(b);
  })[0]||null;
}
export async function resolveSpeakerModel({force=false,key}={}){
  const {speakerInferenceConfig}=await import('./speaker-inference.mjs');
  const inference=await speakerInferenceConfig();
  if(inference.backend==='pool')return {policy:'pool-explicit',model:inference.model,backend:'pool',reasoning_effort:inference.reasoning_effort};
  if(inference.model!=='latest-luna')return {policy:'explicit',model:inference.model};
  if(process.env.CRM_SPEAKER_MODEL&&process.env.CRM_SPEAKER_MODEL!=='latest-luna')return {policy:'explicit',model:process.env.CRM_SPEAKER_MODEL};
  const filename=path.join(stateDir,'speaker-model.json');let cached;
  try{cached=JSON.parse(await fs.readFile(filename,'utf8'));}catch{}
  if(!force&&cached?.model&&Date.now()-Date.parse(cached.checked_at)<86400000)return cached;
  try{
    const listed=await openaiRequest('models',null,{key}),model=newestLuna(listed.data||[]);
    if(!model)throw new Error('No canonical Luna model is available to the CRM API project');
    const result={policy:'latest-luna',model,checked_at:new Date().toISOString()};
    await fs.mkdir(stateDir,{recursive:true,mode:0o700});
    await fs.writeFile(filename+'.tmp',JSON.stringify(result)+'\n',{mode:0o600});await fs.rename(filename+'.tmp',filename);
    return result;
  }catch(error){
    if(cached?.model)return {...cached,refresh_error:error.message};
    throw error;
  }
}
