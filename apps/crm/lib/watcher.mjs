import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {settings,stateDir} from './config.mjs';
import {archiveRecording,cloudInbox,indexCloudRecording,jobs} from './archive.mjs';
import {refreshTranscripts,sourceStatus} from './store.mjs';
import {queryRows,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';

let busy=false,cloudBusy=false,indexBusy=false,lastCloud=0,cloudError=null;
const cloudQueue=new Map();
const stable=new Map(),completed=new Set();
let cloudPending=[];
const probeFile=promisify(execFile);
export async function recordingStatus(){
  const s=settings();let folderExists=true;try{await fs.access(s.recordingFolder);}catch{folderExists=false;}
  return {folder:s.recordingFolder,enabled:s.watchRecordings,watchFrom:s.watchFrom,folderExists,owner:s.ownerEmail,jobs:[...jobs].map(([id,job])=>({id,...job})),cloudPending,cloudError,lastCloudScan:lastCloud?new Date(lastCloud).toISOString():null};
}
export async function scanRecordings(){
  if(busy)return;busy=true;
  try{
    const s=settings();
    if(s.watchRecordings){
      const entries=await fs.readdir(s.recordingFolder,{withFileTypes:true});
      for(const entry of entries){
        if(!entry.isFile()||!/^Screen Recording .*\.(mov|mp4)$/i.test(entry.name))continue;
        const file=path.join(s.recordingFolder,entry.name),stat=await fs.stat(file);
        if(stat.mtimeMs<Date.parse(s.watchFrom)||completed.has(file)||stat.size<=0)continue;
        const previous=stable.get(file);
        if(!previous||previous.size!==stat.size||previous.mtimeMs!==stat.mtimeMs){stable.set(file,{size:stat.size,mtimeMs:stat.mtimeMs,seenAt:Date.now()});continue;}
        if(Date.now()-previous.seenAt<30000)continue;
        // A closed capture has a readable media duration; an unfinished movie is queued.
        let probe;try{probe=await probeFile('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{encoding:'utf8',timeout:15000});}catch{continue;}
        if(!(Number(probe.stdout)>0))continue;
        const known=await queryRows(`SELECT asset_id FROM media_archive_assets WHERE source_filename=${q(entry.name)} AND bytes=${stat.size};`,{rowLimit:1});
        if(known.length){completed.add(file);continue;}
        await archiveRecording(file,s.ownerEmail);completed.add(file);
      }
      await sourceStatus(s.ownerEmail,'recordings',s.ownerEmail,'connected',{success:true,metadata:{watching:s.recordingFolder,watch_from:s.watchFrom,automatic:true,local_originals_retained:true}});
    }
    await fs.writeFile(path.join(stateDir,'recording-watch-status.json'),JSON.stringify({lastScan:new Date().toISOString(),jobs:[...jobs.values()]}));
  }catch(error){console.error('Recording scan:',error.message);try{await sourceStatus(settings().ownerEmail,'recordings',settings().ownerEmail,'error',{error:error.message});}catch{}}
  finally{busy=false;}
}
async function drainCloudQueue(){
  if(indexBusy)return;indexBusy=true;
  try{
    for(const [uri,item] of cloudQueue){
      jobs.set(uri,{name:item.name,status:'indexing cloud upload',bytes:item.bytes});
      try{await indexCloudRecording(item);jobs.set(uri,{name:item.name,status:'archived',bytes:item.bytes});}
      catch(error){jobs.set(uri,{name:item.name,status:'error',error:error.message});}
      cloudQueue.delete(uri);
    }
  }finally{indexBusy=false;}
}
export async function scanCloud(){
  if(settings().sharedCatalogInCloud&&process.env.CRM_HOSTED!=='true')return;
  if(cloudBusy)return;cloudBusy=true;
  try{
    cloudPending=await cloudInbox();lastCloud=Date.now();cloudError=null;
    for(const item of cloudPending){cloudQueue.set(item.uri,item);if(!jobs.has(item.uri)||jobs.get(item.uri).status==='error')jobs.set(item.uri,{name:item.name,status:'queued for cloud verification',bytes:item.bytes});}
    // Verification may stream a large file; discovery and SQL polling stay independent.
    void drainCloudQueue();
    await refreshTranscripts();
  }catch(error){cloudError=error.message;console.error('Cloud storage scan:',error.message);}
  finally{cloudBusy=false;}
}
export function startWatcher(){
  const timer=setInterval(()=>scanRecordings(),15000);timer.unref();
  setInterval(()=>scanCloud(),60000).unref();
  setTimeout(()=>{void scanRecordings();void scanCloud();},5000).unref();return timer;
}
