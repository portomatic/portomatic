import http from 'node:http';
import {SnapshotCache} from './lib/snapshot-cache.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {appDir,settings,saveSettings,googleClient,stateDir} from './lib/config.mjs';
import {state,initMembers,refreshArchive,refreshTranscripts,importItems,updatePerson,addNote,email,getMembers,recording,assignOwner,mergePeople,findPeople} from './lib/store.mjs';
import {beginGoogle,finishGoogle,syncAll,localGoogleAccounts} from './lib/google.mjs';
import {recordingStatus,startWatcher,scanRecordings,scanCloud} from './lib/watcher.mjs';
import {archiveRecording,gcloud,indexCloudRecording,jobs} from './lib/archive.mjs';
import {signUrl} from '../../customers/scripts/lib/sign-url.mjs';
import {loadMediaConfig} from '../../media/scripts/lib/config.mjs';
import {importLinkedin} from './lib/linkedin.mjs';
import {createAccess} from './lib/access.mjs';
import {enqueueTranscription} from './lib/transcription.mjs';
import {enqueueSpeakerJobs} from './lib/speakers.mjs';
import {resolveSpeakerModel} from './lib/openai.mjs';
import {salesFeedbackReport,feedbackText} from './lib/sales-feedback.mjs';
import {queryRows,sqlLiteral as q} from '../../customers/scripts/lib/db.mjs';
import {companiesState,updateCompany,linkCompanyPerson} from './lib/companies.mjs';

const hosted=process.env.CRM_HOSTED==='true';
const authenticate=hosted?createAccess():null;
const hosts=new Set(hosted?['crm.portomatic.com']:['crm.localhost','localhost','127.0.0.1','[::1]']);
const defaultQuery={limit:'150',view:'timeline'};
const warmQueries=[defaultQuery,{limit:'150',view:'recordings',kind:'recording'}];
const snapshotFile=query=>path.join(stateDir,query.view+'-snapshot.json');
async function initialize(){
  for(;;){
    try{return await initMembers();}catch(error){
      if(!/429|RESOURCE_EXHAUSTED|Quota exceeded|503|504/.test(error.message))throw error;
      console.error('CRM initialization temporarily unavailable; retrying in 15 seconds:',error.message);
      await new Promise(resolve=>setTimeout(resolve,15000));
    }
  }
}
const initializing=initialize();
const dataCache=new SnapshotCache(async query=>{await initializing;return query.view==='companies'?companiesState(query):state(query);},{onUpdate:async(query,entry)=>{
  if(!warmQueries.some(q=>dataCache.key(query)===dataCache.key(q)))return;
  const file=snapshotFile(query);
  await fs.writeFile(file+'.tmp',JSON.stringify({version:2,...entry}),{mode:0o600});await fs.rename(file+'.tmp',file);
}});
await Promise.all(warmQueries.map(async query=>{
  try{const snapshot=JSON.parse(await fs.readFile(snapshotFile(query),'utf8'));if(snapshot.version===2&&Array.isArray(snapshot.data?.timeline)&&snapshot.syncedAt)dataCache.seed(query,snapshot.data,snapshot.syncedAt);}catch{}
}));
const refreshTimeline=()=>Promise.all(warmQueries.map(query=>dataCache.refresh(query).catch(error=>console.error('Timeline refresh:',error.message))));
let catalogRefresh=null,lastCatalogRefresh=0,lastCatalogAttempt=0,catalogError=null;
async function ensureFreshCatalog(){
  if(!hosted&&settings().sharedCatalogInCloud)return;
  if(Date.now()-lastCatalogAttempt<60000)return catalogRefresh;
  if(!catalogRefresh){lastCatalogAttempt=Date.now();catalogRefresh=refreshArchive().then(()=>{lastCatalogRefresh=Date.now();catalogError=null;void refreshTimeline();}).catch(error=>{catalogError=error.message;throw error;}).finally(()=>{catalogRefresh=null;});}
  await catalogRefresh;
}
const background=new Map();
function backgroundJob(name,fn){
  if(background.get(name)?.status==='running')return;
  background.set(name,{status:'running',started:new Date().toISOString()});
  Promise.resolve().then(fn).then(result=>{background.set(name,{status:'done',result,finished:new Date().toISOString()});void refreshTimeline();}).catch(error=>{background.set(name,{status:'error',error:error.message});console.error(name,error.message);});
}
function send(res,code,value){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){let bytes=0,raw='';for await(const chunk of req){bytes+=chunk.length;if(bytes>8*1024*1024)throw new Error('Request too large');raw+=chunk;}return raw?JSON.parse(raw):{};}
function page(res,title,message){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px Arial;margin:60px;max-width:620px"><h1 style="font-size:22px;font-weight:400">${title}</h1><p>${String(message).replaceAll('&','&amp;').replaceAll('<','&lt;')}</p><p><a href="http://crm.localhost/#timeline">Return to CRM</a></p>`);}

const server=http.createServer(async(req,res)=>{
  try{
    const requestUrl=new URL(req.url,'http://'+req.headers.host);
    if(!hosts.has(requestUrl.hostname)){send(res,403,{error:'Access denied'});return;}
    let identity=settings().ownerEmail;
    if(hosted){try{identity=await authenticate(req.headers['cf-access-jwt-assertion']||'');}catch{send(res,403,{error:'Sign in with your Portomatic account'});return;}}
    const origin=req.headers.origin;
    if(origin){let valid=false;try{valid=hosted?origin==='https://crm.portomatic.com':hosts.has(new URL(origin).hostname);}catch{}if(!valid){send(res,403,{error:'Invalid request origin'});return;}}
    if(!['GET','HEAD'].includes(req.method)&&!String(req.headers['content-type']).startsWith('application/json')){send(res,415,{error:'Use JSON for dashboard changes'});return;}
    res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');
    const p=requestUrl.pathname;
    if(hosted&&['/api/config','/api/settings','/api/google/start','/api/google/callback','/api/google/client','/api/import','/api/linkedin','/api/recordings/archive'].includes(p)){send(res,404,{error:'Not found'});return;}
    if(p==='/api/health'){send(res,200,{ok:true,app:'portomatic-crm'});return;}
    const staticFiles={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/companies.js':['companies.js','text/javascript'],'/style.css':['style.css','text/css']};
    if(staticFiles[p]&&['GET','HEAD'].includes(req.method)){
      const [file,type]=staticFiles[p];res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-cache','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(req.method==='HEAD'?undefined:await fs.readFile(path.join(appDir,'public',file)));return;
    }
    if(p==='/api/state'&&req.method==='GET'){
      const query={...defaultQuery,...Object.fromEntries(requestUrl.searchParams)};
      send(res,200,await dataCache.read(query));return;
    }
    if(p==='/api/people'&&req.method==='GET'){send(res,200,await findPeople(requestUrl.searchParams.get('search')||''));return;}
    if(p==='/api/company'&&req.method==='POST'){const v=await body(req);const result=await updateCompany(v.id,v,identity);dataCache.clear();send(res,200,result);return;}
    if(p==='/api/company/person'&&req.method==='POST'){const result=await linkCompanyPerson(await body(req),identity);dataCache.clear();send(res,200,result);return;}
    if(/^\/api\/recording\/[a-f0-9-]{36}\/transcribe$/i.test(p)&&req.method==='POST'){
      const id=p.split('/')[3];await recording(id);
      const jobs=await enqueueTranscription(id,{requestedBy:identity});dataCache.clear();send(res,202,{queued:true,jobs});return;
    }
    if(/^\/api\/recording\/[a-f0-9-]{36}\/transcript$/i.test(p)&&req.method==='GET'){
      const id=p.split('/')[3];await recording(id);
      const rows=await queryRows(`SELECT tr.run_id,tr.provider,tr.model,tr.artifact_uri,s.sequence,s.start_ms,s.end_ms,s.display_speaker AS speaker,s.original_speaker,s.inferred_name,s.name_confidence,s.name_reason,s.name_evidence,s.speaker_model,s.transcript,s.confidence FROM crm_transcripts tr JOIN crm_named_transcript_segments s USING(run_id) WHERE tr.touchpoint_id=${q(id)}::uuid AND tr.is_current ORDER BY s.sequence;`);
      send(res,200,{segments:rows});return;
    }
    if(/^\/api\/recording\/[a-f0-9-]{36}\/speakers$/i.test(p)&&req.method==='POST'){
      const id=p.split('/')[3];await recording(id);
      const {model}=await resolveSpeakerModel();
      const jobs=await enqueueSpeakerJobs({recordingId:id,model,force:true});
      if(!jobs.length)throw new Error('A complete transcript is needed before naming speakers');
      send(res,202,{queued:true,jobs});return;
    }
    if(/^\/api\/recording\/[a-f0-9-]{36}\/sales-feedback$/i.test(p)&&req.method==='GET'){
      const result=await salesFeedbackReport(p.split('/')[3]);
      if(!result||result.status!=='complete'){send(res,404,{error:'Sales feedback is not available yet'});return;}
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
      const feedback=feedbackText(result.report.feedback);
      res.end(`${result.title}\nYC sales feedback\n\n${feedback}\n`);return;
    }
    if(p==='/api/config'&&req.method==='GET'){
      const accounts=await localGoogleAccounts();let progress=null;try{progress=JSON.parse(await fs.readFile(path.join(stateDir,'linkedin-progress.json'),'utf8'));}catch{}
      send(res,200,{settings:settings(),googleClientConfigured:!!googleClient(),googleProject:googleClient()?.projectId,accounts,recordings:await recordingStatus(),catalog:{lastSuccess:lastCatalogRefresh?new Date(lastCatalogRefresh).toISOString():null,error:catalogError},jobs:Object.fromEntries(background),linkedinProgress:progress});return;
    }
    await initializing;
    if(p==='/api/settings'&&req.method==='POST'){
      const value=await body(req),members=await getMembers(),updates={};
      if(value.ownerEmail){updates.ownerEmail=email(value.ownerEmail);if(!members.some(m=>m.email===updates.ownerEmail))throw new Error('Choose a team member');}
      if(value.recordingFolder){const folder=path.resolve(value.recordingFolder);if(!(await fs.stat(folder)).isDirectory())throw new Error('Choose a recording folder that exists');updates.recordingFolder=folder;}
      if(typeof value.watchRecordings==='boolean')updates.watchRecordings=value.watchRecordings;
      if(value.gmailQuery!==undefined)updates.gmailQuery=String(value.gmailQuery).slice(0,1000);
      send(res,200,{settings:saveSettings(updates)});return;
    }
    if(p==='/api/google/start'&&req.method==='POST'){const value=await body(req);send(res,200,{url:await beginGoogle(value.ownerEmail)});return;}
    if(p==='/api/google/callback'){
      try{const result=await finishGoogle(requestUrl.searchParams);backgroundJob('google-sync',syncAll);page(res,'Google connected',`${result.account} is connected for ${result.owner}. Read-only email, calendar and Drive sync has started.`);}catch(error){page(res,'Google connection needs attention',error.message);}return;
    }
    if(p==='/api/google/client'&&req.method==='POST'){
      const value=await body(req),config=value.installed||value.web;
      if(!config?.client_id||!config?.client_secret)throw new Error('Choose the Google OAuth Desktop client JSON file');
      await fs.writeFile(path.join(stateDir,'google-client.json'),JSON.stringify(value),{mode:0o600});send(res,200,{saved:true});return;
    }
    if(p==='/api/sync'&&req.method==='POST'){
      if(!hosted){backgroundJob('google-sync',syncAll);backgroundJob('recording-scan',scanRecordings);}backgroundJob('cloud-scan',scanCloud);dataCache.clear();send(res,202,{started:true});return;
    }
    if(p==='/api/import'&&req.method==='POST'){const result=await importItems(await body(req));dataCache.clear();send(res,200,result);return;}
    if(p==='/api/person'&&req.method==='POST'){const v=await body(req);await updatePerson(v.id,v);dataCache.clear();send(res,200,{saved:true});return;}
    if(p==='/api/merge'&&req.method==='POST'){const v=await body(req);await mergePeople(v.fromId,v.toId);dataCache.clear();send(res,200,{saved:true});return;}
    if(p==='/api/owner'&&req.method==='POST'){const v=await body(req);await assignOwner(v.id,v.ownerEmail);dataCache.clear();send(res,200,{saved:true});return;}
    if(p==='/api/note'&&req.method==='POST'){const v=await body(req);const owner=hosted?(identity==='zach@portomatic.com'?'zach@toonworld.io':identity):v.ownerEmail||settings().ownerEmail;await addNote(v.personId,v.body,owner);dataCache.clear();send(res,200,{saved:true});return;}
    if(p==='/api/linkedin'&&req.method==='POST'){
      const v=await body(req);if(!path.isAbsolute(v.path||''))throw new Error('Choose the full path to the downloaded LinkedIn archive');
      if(!['.zip','.csv'].includes(path.extname(v.path).toLowerCase()))throw new Error('Choose a LinkedIn ZIP or Connections.csv');
      backgroundJob('linkedin-import',()=>importLinkedin(v.path,v.ownerEmail||settings().ownerEmail));send(res,202,{started:true});return;
    }
    if(p==='/api/recordings/archive'&&req.method==='POST'){
      const v=await body(req);if(!path.isAbsolute(v.path||''))throw new Error('Enter the full local recording path');
      backgroundJob('recording:'+v.path,()=>archiveRecording(v.path,v.ownerEmail||settings().ownerEmail));send(res,202,{started:true});return;
    }
    if(p.startsWith('/api/recording/')&&req.method==='GET'){
      const item=await recording(p.split('/').pop());
      let signedUrl;
      if(item.source==='customer-recording')signedUrl=signUrl(item.storage_uri).signedUrl;
      else{
        const cfg=loadMediaConfig(),data=JSON.parse(await gcloud(['storage','sign-url',item.storage_uri,'--duration=15m',`--region=${cfg.location}`,'--format=json'],{write:true}));
        const search=v=>{if(typeof v==='string'&&v.startsWith('https://')&&/X-Goog-Signature/i.test(v))return v;if(v&&typeof v==='object')for(const x of Object.values(v)){const found=search(x);if(found)return found;}};
        signedUrl=search(data);if(!signedUrl)throw new Error('Could not open this recording');
      }
      res.writeHead(302,{location:signedUrl,'cache-control':'no-store'});res.end();return;
    }
    send(res,404,{error:'Not found'});
  }catch(error){console.error(error.stack);send(res,error.message.includes('not found')?404:400,{error:error.message});}
});

server.listen(settings().port,'127.0.0.1',()=>console.log(`Portomatic CRM: ${hosted?'https://crm.portomatic.com':'http://crm.localhost'} (127.0.0.1:${settings().port})`));
void refreshTimeline();
setInterval(()=>void refreshTimeline(),15000).unref();
initializing.then(()=>{startWatcher();void ensureFreshCatalog().catch(e=>console.error('Cloud catalog refresh:',e.message));setInterval(()=>ensureFreshCatalog().catch(e=>console.error('Cloud catalog refresh:',e.message)),15000).unref();if(!hosted){setInterval(()=>backgroundJob('google-sync',syncAll),60000).unref();backgroundJob('google-sync',syncAll);}}).catch(error=>console.error('CRM initialization failed:',error));
