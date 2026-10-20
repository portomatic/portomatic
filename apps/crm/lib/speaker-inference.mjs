import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {stateDir} from './config.mjs';
import {openaiRequest} from './openai.mjs';
const POOL_BASE='https://pool-api.portomatic.com/backend-api/codex';
export async function speakerInferenceConfig(){
  let saved={};
  try{saved=JSON.parse(await fs.readFile(path.join(stateDir,'speaker-inference.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Invalid speaker inference configuration');}
  const backend=process.env.CRM_SPEAKER_BACKEND||saved.backend||'openai';
  if(!['openai','pool'].includes(backend))throw Error('Unknown speaker inference backend');
  return {backend,model:process.env.CRM_SPEAKER_MODEL||saved.model||(backend==='pool'?'gpt-6.1-sol':'latest-luna'),
    reasoning_effort:process.env.CRM_SPEAKER_REASONING_EFFORT||saved.reasoning_effort||'medium',
    key_file:process.env.CRM_POOL_KEY_FILE||saved.key_file||path.join(stateDir,'pool/api-key'),base_url:POOL_BASE};
}
// Pool sends SSE even for background workflows. Only a completed response is
// publishable; partial tool calls/text and keepalives never become a result.
export async function readPoolResponse(response){
  if(!response.headers.get('content-type')?.includes('text/event-stream')){
    const value=await response.json();
    if(value?.status!=='completed')throw Error('Pool did not return a completed response');
    return value;
  }
  if(!response.body)throw Error('Pool returned an empty stream');
  const decoder=new TextDecoder();let buffer='',bytes=0,completed;
  function event(block){
    const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    let value;try{value=JSON.parse(data);}catch{throw Error('Pool returned malformed stream data');}
    if(value.type==='response.completed'){
      if(value.response?.status!=='completed')throw Error('Pool response completion was invalid');
      completed=value.response;
    }
    if(['response.failed','response.incomplete','error'].includes(value.type))throw Error('Pool inference failed: '+String(value.response?.error?.code||value.error?.code||value.code||value.type).slice(0,100));
  }
  for await(const chunk of response.body){
    bytes+=chunk.length;if(bytes>32*1024*1024)throw Error('Pool response exceeded byte budget');
    buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replaceAll('\r\n','\n');
    let end;while((end=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,end));buffer=buffer.slice(end+2);}
  }
  buffer+=decoder.decode();if(buffer.trim())event(buffer);
  if(!completed)throw Error('Pool stream ended before response.completed');
  return completed;
}
export async function poolSpeakerRequest(resource,body,{signal,config,fetchImpl=fetch,sessionId=crypto.randomUUID()}={}){
  if(resource!=='responses'||!body)throw Error('Pool speaker transport only supports Responses');
  config??=await speakerInferenceConfig();
  const key=(process.env.CRM_POOL_API_KEY||(await fs.readFile(config.key_file,'utf8'))).trim();
  if(!key)throw Error('Pool credential is empty');
  const response=await fetchImpl(POOL_BASE+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:'text/event-stream',
    originator:'portomatic_crm','user-agent':'codex_cli_rs/0.163.0 (Portomatic CRM)','version':'0.163.0','x-codex-session-id':sessionId,session_id:sessionId},
    body:JSON.stringify({...body,store:false,stream:true,reasoning:{...body.reasoning,effort:config.reasoning_effort}}),
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000)});
  if(!response.ok){
    // Never include arbitrary gateway bodies in logs: they may echo inputs.
    let code;try{const v=await response.json();code=v.error?.code||v.error?.type;}catch{}
    throw Error(`Pool Responses failed (${response.status})${code?': '+String(code).slice(0,100):''}`);
  }
  const value=await readPoolResponse(response);
  if(value.model&&value.model!==body.model)throw Error('Pool returned a different model than requested');
  return {...value,portomatic_inference:{backend:'pool',endpoint:POOL_BASE,requested_model:body.model,reasoning_effort:config.reasoning_effort,
    billing_note:'Pool may overflow to its own paid API; response alone does not establish billing route.'}};
}
export async function createSpeakerRequest(){
  const config=await speakerInferenceConfig(),sessionId=crypto.randomUUID();
  if(config.backend==='openai')return {config,request:openaiRequest};
  return {config,request:(resource,body,options)=>poolSpeakerRequest(resource,body,{...options,config,sessionId})};
}
