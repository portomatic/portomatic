import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadMediaConfig} from '../../../media/scripts/lib/config.mjs';
import {loadConfig} from '../../../customers/scripts/lib/config.mjs';
import {queryRows,executeSql,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';
import {stateDir} from './config.mjs';

export const jobs=new Map();
const cfg=loadMediaConfig();
const writeArgs=[`--project=${cfg.projectId}`,`--impersonate-service-account=${cfg.uploaderServiceAccount}`];
export async function gcloud(args,{capture=true,write=false}={}){
  return await new Promise((resolve,reject)=>{
    const child=spawn('gcloud',[...args,`--project=${cfg.projectId}`,...(write?[`--impersonate-service-account=${cfg.uploaderServiceAccount}`]:[])],{env:{...process.env,CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
    let out='',err='';
    child.stdout.on('data',b=>{if(capture)out+=b;});child.stderr.on('data',b=>{err=(err+b).slice(-12000);});
    child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error(`Cloud storage operation failed: ${err}`)));
  });
}
export const meta=o=>o.metadata||o.custom_metadata||o.custom_fields||{};
export const md5=o=>o.md5Hash||o.md5_hash;
export const describe=async uri=>JSON.parse(await gcloud(['storage','objects','describe',uri,'--format=json']));
export async function hashes(filename){
  const sha=crypto.createHash('sha256'),md=crypto.createHash('md5');
  for await(const chunk of fs.createReadStream(filename)){sha.update(chunk);md.update(chunk);}
  return {sha256:sha.digest('hex'),md5:md.digest('base64')};
}
export function stableId(value){
  const b=crypto.createHash('sha256').update(value).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export async function uploadJson(key,value,{write=true}={}){
  const body=JSON.stringify(value,null,2)+'\n',sha=crypto.createHash('sha256').update(body).digest('hex');
  const file=path.join(stateDir,'manifest-'+sha+'.json');await fsp.writeFile(file,body,{mode:0o600});
  const h=await hashes(file),uri=`gs://${cfg.bucket}/${key.replace('{sha}',sha)}`;
  await gcloud(['storage','cp','--no-clobber',`--content-md5=${h.md5}`,'--content-type=application/json',`--custom-metadata=portomatic-sha256=${sha}`,file,uri],{write});
  const o=await describe(uri);
  if(Number(o.size)!==Buffer.byteLength(body)||md5(o)!==h.md5||meta(o)['portomatic-sha256']!==sha)throw new Error('Cloud manifest checksum mismatch');
  await fsp.unlink(file);
  return {uri,sha256:sha,generation:String(o.generation)};
}

export async function archiveOriginal(filename,{ownerEmail,classification,provider='recordings'}={}){
  const before=await fsp.stat(filename,{bigint:true});
  if(!before.isFile()||before.size<=0)throw new Error('Choose a finished, nonempty file');
  jobs.set(filename,{name:path.basename(filename),status:'hashing',bytes:String(before.size)});
  const h=await hashes(filename),name=path.basename(filename);
  const ext=path.extname(filename).toLowerCase();
  const contentType=({'.zip':'application/zip','.csv':'text/csv','.mov':'video/quicktime','.mp4':'video/mp4','.m4a':'audio/mp4','.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.aiff':'audio/aiff','.caf':'audio/x-caf','.webm':'video/webm'})[ext]||'application/octet-stream';
  const prefix=provider==='linkedin'?'crm-imports/linkedin':'raw-videos';
  const uri=`gs://${cfg.bucket}/${prefix}/${h.sha256}/${name}`;
  const id=stableId(`${h.sha256}\0${name}`);
  jobs.set(filename,{name,status:'uploading',bytes:String(before.size)});
  await gcloud(['storage','cp','--no-clobber',`--content-md5=${h.md5}`,`--content-type=${contentType}`,`--custom-metadata=portomatic-sha256=${h.sha256},portomatic-asset-id=${id},portomatic-uploader-email=${ownerEmail||'unknown'},portomatic-classification=${classification||'unreviewed'}`,filename,uri],{write:true});
  const after=await fsp.stat(filename,{bigint:true});
  if(before.size!==after.size||before.mtimeNs!==after.mtimeNs)throw new Error('File changed during upload; original retained and indexing stopped');
  const o=await describe(uri);
  if(Number(o.size)!==Number(before.size)||md5(o)!==h.md5||meta(o)['portomatic-sha256']!==h.sha256)throw new Error('Cloud original checksum mismatch');
  const receipt={asset_id:id,source_filename:name,storage_uri:uri,object_generation:String(o.generation),sha256:h.sha256,md5_base64:h.md5,bytes:String(before.size),content_type:contentType,owner_email:ownerEmail||null,classification:classification||'unreviewed',original_path:filename,original_mtime_ns:String(before.mtimeNs),local_original_retained:true};
  const manifest=await uploadJson(`crm-manifests/${id}/{sha}.json`,{manifest_version:1,asset:receipt,archival_method:'Unchanged local original; local SHA-256 and MD5, server-stored MD5, byte count and exact cloud generation verified.'});
  jobs.set(filename,{name,status:'verified',bytes:String(before.size)});
  return {...receipt,manifest_uri:manifest.uri,manifest_generation:manifest.generation,manifest_sha256:manifest.sha256};
}

export function captureTime(name,fallback){
  const m=name.match(/Screen Recording (\d{4})-(\d{2})-(\d{2}) at (\d+)\.(\d+)\.(\d+)\s*([AP]M)/i);
  if(!m)return {at:new Date(fallback).toISOString(),precision:'filesystem'};
  return {at:new Date(+m[1],+m[2]-1,+m[3],+m[4]%12+(m[7].toUpperCase()==='PM'?12:0),+m[5],+m[6]).toISOString(),precision:'second'};
}
async function duration(file){
  return await new Promise(resolve=>{
    const p=spawn('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);let out='';p.stdout.on('data',b=>out+=b);p.on('error',()=>resolve(null));p.on('close',code=>resolve(code===0&&Number(out)>0?Math.round(Number(out)*1000):null));
  });
}
export async function catalogMedia(receipt,{capturedAt,precision='filesystem',durationMs=null}={}){
  const r=receipt;
  const cols=['asset_id','storage_uri','object_generation','sha256','md5_base64','bytes','duration_ms','content_type','source_filename','captured_at','captured_at_precision','classification','source_kind','parent_asset_id','manifest_uri','manifest_generation','manifest_sha256'];
  const vals=[r.asset_id,r.storage_uri,r.object_generation,r.sha256,r.md5_base64,r.bytes,durationMs,r.content_type,r.source_filename,capturedAt||new Date().toISOString(),precision,r.classification,'original',null,r.manifest_uri,r.manifest_generation,r.manifest_sha256];
  await executeSql(`INSERT INTO media_archive_assets(${cols.join(',')}) VALUES (${vals.map(q).join(',')}) ON CONFLICT DO NOTHING;`,{application:'portomatic_crm_archive'});
  const rows=await queryRows(`SELECT * FROM media_archive_assets WHERE sha256=${q(r.sha256)} AND source_filename=${q(r.source_filename)};`,{rowLimit:2});
  if(rows.length!==1||Number(rows[0].bytes)!==Number(r.bytes))throw new Error('Archive catalog verification failed');
  return rows[0];
}
export async function archiveRecording(file,ownerEmail){
  try{
    const {refreshArchive,enrichRecording,sourceStatus}=await import('./store.mjs');
    const info=await fsp.stat(file),captured=captureTime(path.basename(file),info.birthtimeMs||info.mtimeMs);
    const r=await archiveOriginal(file,{ownerEmail,classification:'business-conversation/unreviewed'});
    const row=await catalogMedia(r,{capturedAt:captured.at,precision:captured.precision,durationMs:await duration(file)});
    await refreshArchive();
    // Ownership is backed by this Mac's explicitly selected uploader.
    await executeSql(`UPDATE crm_touchpoints SET owner_id=(SELECT member_id FROM crm_members WHERE email=${q(ownerEmail)}),raw=raw || ${q(JSON.stringify({uploader_email:ownerEmail,ownership_provenance:'Selected founder on the uploading Mac'}))}::jsonb WHERE source='media-archive' AND external_id=${q(row.asset_id)};`);
    await sourceStatus(ownerEmail,'recordings',ownerEmail,'connected',{success:true,metadata:{last_file:r.source_filename,storage_uri:r.storage_uri}});
    jobs.set(file,{name:path.basename(file),status:'archived',bytes:r.bytes});
    return r;
  }catch(error){jobs.set(file,{name:path.basename(file),status:'error',error:error.message});throw error;}
}

export async function cloudInbox(){
  const buckets=[...new Set([cfg.bucket,loadConfig().bucket].filter(Boolean))];
  const objects=(await Promise.all(buckets.map(async bucket=>JSON.parse(await gcloud(['storage','ls','--json',`gs://${bucket}/**`]))))).flat();
  const known=await queryRows('SELECT storage_uri FROM media_archive_assets UNION SELECT storage_uri FROM recording_objects;');
  const set=new Set(known.map(r=>r.storage_uri));
  return objects.filter(x=>x.type==='cloud_object'&&!/^(oracle-captures|crm-transcripts)\//.test(x.metadata.name)&&/\.(mov|mp4|m4v|mkv|m4a|mp3|wav|webm|flac|ogg|aiff|caf)$/i.test(x.metadata.name)&&!set.has(x.url.split('#')[0])).map(x=>({uri:x.url.split('#')[0],generation:x.metadata.generation,name:path.basename(x.metadata.name),bytes:x.metadata.size,createdAt:x.metadata.timeCreated,owner:meta(x.metadata)['portomatic-uploader-email']||null,md5:x.metadata.md5Hash,contentType:x.metadata.contentType}));
}

export async function indexCloudRecording(item){
  const uri=item.uri;
  if(![cfg.bucket,loadConfig().bucket].some(bucket=>uri?.startsWith(`gs://${bucket}/`)))throw new Error('Recording must be in a configured company bucket');
  const o=await describe(uri),h=crypto.createHash('sha256'),downloadMd5=crypto.createHash('md5');let readBytes=0;
  const generation=String(o.generation);
  // Pin the exact generation; never read a changing cloud object by bare name.
  await new Promise((resolve,reject)=>{
    const p=spawn('gcloud',['storage','cat',`${uri}#${generation}`,`--project=${cfg.projectId}`],{stdio:['ignore','pipe','pipe']});let err='';
    p.stdout.on('data',b=>{h.update(b);downloadMd5.update(b);readBytes+=b.length;});p.stderr.on('data',b=>err=(err+b).slice(-3000));p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error(err)));
  });
  const sha=h.digest('hex'),name=path.basename(o.name||uri),id=stableId(`${sha}\0${name}`),owner=meta(o)['portomatic-uploader-email']||null;
  if(readBytes!==Number(o.size)||downloadMd5.digest('base64')!==md5(o))throw new Error('Downloaded cloud generation failed MD5 or byte verification');
  if(meta(o)['portomatic-sha256']&&meta(o)['portomatic-sha256']!==sha)throw new Error('Cloud SHA-256 metadata mismatch');
  const r={asset_id:id,source_filename:name,storage_uri:uri,object_generation:generation,sha256:sha,md5_base64:md5(o),bytes:String(o.size),content_type:o.contentType||o.content_type||'video/quicktime',owner_email:owner,classification:meta(o)['portomatic-classification']||'business-conversation/unreviewed'};
  if(!r.md5_base64)throw new Error('Cloud file has no stored MD5; needs an independent verification path');
  const mf=await uploadJson(`crm-manifests/${id}/{sha}.json`,{manifest_version:1,asset:r,provenance:'Direct cloud upload; SHA-256 computed by reading the pinned cloud generation; owner retained from object metadata, otherwise unknown.'});
  Object.assign(r,{manifest_uri:mf.uri,manifest_generation:mf.generation,manifest_sha256:mf.sha256});
  const time=captureTime(name,o.timeCreated||o.creation_time||Date.now());
  const row=await catalogMedia(r,{capturedAt:time.at,precision:time.precision});
  const {refreshArchive}=await import('./store.mjs');await refreshArchive();
  await executeSql(`UPDATE crm_touchpoints SET owner_id=coalesce((SELECT member_id FROM crm_members WHERE email=${q(owner)}),owner_id),raw=raw || ${q(JSON.stringify({source_metadata:meta(o)}))}::jsonb WHERE source='media-archive' AND external_id=${q(row.asset_id)};`);
  return r;
}
