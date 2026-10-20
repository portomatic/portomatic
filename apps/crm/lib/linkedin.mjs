import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {appDir,stateDir} from './config.mjs';
import {archiveOriginal,stableId} from './archive.mjs';
import {queryRows,executeSql as executeOnce,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';
import {sourceStatus,email,json} from './store.mjs';

const exec=promisify(execFile);
async function executeSql(sql,options){
  for(let attempt=0;;attempt++){
    try{return await executeOnce(sql,options);}catch(error){
      if(!/429|Quota exceeded|RESOURCE_EXHAUSTED|execution timed out/.test(error.message)||attempt>=6)throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(60000,15000*(attempt+1))));
    }
  }
}
export function linkedinUrl(value){
  try{const u=new URL(value);if(!/(^|\.)linkedin\.com$/i.test(u.hostname)||!/^\/in\/[^/]+\/?$/.test(u.pathname))return null;return 'https://www.linkedin.com'+u.pathname.replace(/\/$/,'');}catch{return null;}
}
function date(value){if(!value)return null;const time=Date.parse(value.includes('UTC')?value.replace(' UTC','Z').replace(' ','T'):value+' 12:00:00 UTC');return Number.isFinite(time)?new Date(time).toISOString():null;}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

export async function importLinkedin(filename,ownerEmail,{exportedAt=null}={}){
  const owner=email(ownerEmail),accounts=await queryRows(`SELECT member_id,name FROM crm_members WHERE email=${q(owner)};`,{rowLimit:1});
  if(!accounts.length)throw new Error('Choose a founder for this archive');
  await sourceStatus(owner,'linkedin',owner,'syncing',{metadata:{file:path.basename(filename)}});
  try{
    const {stdout}=await exec('python3',[path.join(appDir,'scripts/read-linkedin.py'),filename],{maxBuffer:100*1024*1024});
    const tables=JSON.parse(stdout),counts=Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length]));
    const r=await archiveOriginal(filename,{ownerEmail:owner,classification:'linkedin-data-export',provider:'linkedin'});
    const archiveId=stableId(`${owner}:linkedin:${r.sha256}`);
    await executeSql(`INSERT INTO crm_import_archives(archive_id,owner_id,provider,source_filename,exported_at,sha256,md5_base64,bytes,storage_uri,object_generation,manifest_uri,manifest_sha256,row_counts)
      VALUES (${q(archiveId)}::uuid,${q(accounts[0].member_id)}::uuid,'linkedin',${q(r.source_filename)},${q(exportedAt)}::timestamptz,${q(r.sha256)},${q(r.md5_base64)},${r.bytes},${q(r.storage_uri)},${q(r.object_generation)}::bigint,${q(r.manifest_uri)},${q(r.manifest_sha256)},${json(counts)}) ON CONFLICT DO NOTHING;`,{application:'portomatic_crm_linkedin'});
    const existingCounts=await queryRows(`SELECT source_file,count(*) AS rows FROM crm_import_rows WHERE archive_id=${q(archiveId)}::uuid GROUP BY source_file;`);
    if(Object.entries(counts).every(([file,count])=>Number(existingCounts.find(c=>c.source_file===file)?.rows)===count)){
      await sourceStatus(owner,'linkedin',owner,'connected',{success:true,metadata:{archive_id:archiveId,storage_uri:r.storage_uri,row_counts:counts,scope:'Downloaded export snapshot; not a live LinkedIn connection'}});
      const total=Object.values(counts).reduce((n,v)=>n+v,0);
      const receipt={...r,archive_id:archiveId,owner_email:owner,row_counts:counts,verified_rows:total,already_imported:true,verified_at:new Date().toISOString()};
      await fs.writeFile(path.join(stateDir,`linkedin-${archiveId}.receipt.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
      await fs.writeFile(path.join(stateDir,'linkedin-progress.json'),JSON.stringify({phase:'complete',file:r.source_filename,done:total,total}));
      return receipt;
    }

    const peopleByProfile=new Map((await queryRows("SELECT profile_url,person_id FROM crm_person_profiles WHERE platform='linkedin';",{rowLimit:100000})).map(r=>[r.profile_url,r.person_id]));
    const peopleByEmail=new Map((await queryRows('SELECT email,person_id FROM crm_person_emails;',{rowLimit:100000})).map(r=>[r.email,r.person_id]));
    const entities=new Map(),byRow=new Map();
    function resolve(profile,mail,name,company='',position=''){
      const url=linkedinUrl(profile);let e=null;try{if(mail)e=email(mail);}catch{}
      if(!url&&!e)return null;
      const personId=peopleByProfile.get(url)||peopleByEmail.get(e)||stableId(url?'linkedin:'+url:'email:'+e);
      if(url)peopleByProfile.set(url,personId);if(e&&!peopleByEmail.has(e))peopleByEmail.set(e,personId);
      const old=entities.get(personId);
      entities.set(personId,{personId,name:(name||old?.name||e||url).trim(),company:company||old?.company||null,position:position||old?.position||null,url:url||old?.url||null,email:e||old?.email||null});
      return personId;
    }
    // The export's own Profile record identifies the account holder, not a prospect.
    const ownerProfile=tables['Profile.csv']?.[0];
    const ownerName=ownerProfile?`${ownerProfile['First Name']} ${ownerProfile['Last Name']}`.trim():accounts[0].name;
    const ownerPerson=resolve(null,owner,ownerName);
    const selfUrls=new Set((tables['messages.csv']||[]).filter(m=>m.FROM===ownerName).map(m=>linkedinUrl(m['SENDER PROFILE URL'])).filter(Boolean));
    for(const url of selfUrls){peopleByProfile.set(url,ownerPerson);entities.get(ownerPerson).url=url;}
    for(const [i,row] of tables['Connections.csv'].entries()){
      const name=`${row['First Name']} ${row['Last Name']}`.trim();
      const id=resolve(row.URL,row['Email Address'],name,row.Company,row.Position);
      byRow.set('Connections.csv:'+i,id);
    }
    for(const row of tables['messages.csv']||[]){
      const sender=linkedinUrl(row['SENDER PROFILE URL']);
      if(sender&&!peopleByProfile.has(sender))resolve(sender,null,row.FROM);
      const urls=(row['RECIPIENT PROFILE URLS']||'').match(/https?:\/\/[^\s,;]+/g)||[];
      for(const u of urls){const url=linkedinUrl(u);if(url&&!peopleByProfile.has(url))resolve(url,null,urls.length===1?row.TO:url.split('/').pop());}
    }
    const entityList=[...entities.values()];
    for(let i=0;existingCounts.length===0&&i<entityList.length;i+=150){
      const batch=entityList.slice(i,i+150),statements=[];
      statements.push(`INSERT INTO crm_people(person_id,name,company,position,relationship) VALUES ${batch.map(p=>`(${q(p.personId)}::uuid,${q(p.name)},${q(p.company)},${q(p.position)},${q(p.personId===ownerPerson?'founder':'unknown')})`).join(',')} ON CONFLICT(person_id) DO UPDATE SET company=coalesce(excluded.company,crm_people.company),position=coalesce(excluded.position,crm_people.position);`);
      const profiles=batch.filter(p=>p.url),emails=batch.filter(p=>p.email);
      if(profiles.length)statements.push(`INSERT INTO crm_person_profiles(platform,profile_url,person_id,provenance) VALUES ${profiles.map(p=>`('linkedin',${q(p.url)},${q(p.personId)}::uuid,${q('export:'+archiveId)})`).join(',')} ON CONFLICT DO NOTHING;`);
      if(emails.length)statements.push(`INSERT INTO crm_person_emails(email,person_id,provenance) VALUES ${emails.map(p=>`(${q(p.email)},${q(p.personId)}::uuid,${q('linkedin-export:'+archiveId)})`).join(',')} ON CONFLICT DO NOTHING;`);
      await executeSql('BEGIN; SELECT pg_advisory_xact_lock(519201001);'+statements.join('\n')+'COMMIT;',{application:'portomatic_crm_linkedin'});
      await fs.writeFile(path.join(stateDir,'linkedin-progress.json'),JSON.stringify({phase:'people',file:r.source_filename,done:Math.min(i+150,entityList.length),total:entityList.length}));
    }
    const alreadyImported=await queryRows(`SELECT source_file,row_number FROM crm_import_rows WHERE archive_id=${q(archiveId)}::uuid;`,{rowLimit:100000});
    const importedRows=new Set(alreadyImported.map(r=>r.source_file+':'+r.row_number));
    let totalRows=alreadyImported.length;
    for(const [sourceFile,rows] of Object.entries(tables)){
      for(let i=0;i<rows.length;){
        const rawValues=[],touchValues=[],linkValues=[];let batchRows=0,sqlBytes=0;
        for(;i<rows.length;){
          const j=i;
          if(importedRows.has(sourceFile+':'+(j+1))){i++;continue;}
          if(batchRows>0&&(sqlBytes>170000||batchRows>=150))break;
          const byteStart=[rawValues.length,touchValues.length,linkValues.length];
          i++;batchRows++;
          const raw=rows[j],personId=byRow.get(sourceFile+':'+j);
          rawValues.push(`(${q(archiveId)}::uuid,${q(sourceFile)},${j+1},${json(raw)},${personId?q(personId)+'::uuid':'NULL'})`);
          if(sourceFile==='Connections.csv'&&personId){
            const occurred=date(raw['Connected On']);
            if(!occurred)continue;
            const key=linkedinUrl(raw.URL)||email(raw['Email Address']);
            const id=stableId(`linkedin-connection:${owner}:${key}`);
            touchValues.push(`(${q(id)}::uuid,'connection','linkedin-connection',${q(owner)},${q(key)},${q(accounts[0].member_id)}::uuid,'Connected on LinkedIn',${q(occurred)}::timestamptz,'',${q(linkedinUrl(raw.URL))},'network connection',${json({archive_id:archiveId,source_file:sourceFile,row_number:j+1,date_precision:'day',original_connected_on:raw['Connected On']})})`);
            linkValues.push(`(${q(id)}::uuid,${q(personId)}::uuid)`);
          }
          if(sourceFile==='messages.csv'){
            const occurred=date(raw.DATE);if(!occurred)continue;
            const key=digest(JSON.stringify([raw['CONVERSATION ID'],raw['SENDER PROFILE URL'],raw['RECIPIENT PROFILE URLS'],raw.DATE,raw.SUBJECT,raw.CONTENT]));
            const id=stableId(`linkedin-message:${owner}:${key}`);
            const urls=[raw['SENDER PROFILE URL'],...((raw['RECIPIENT PROFILE URLS']||'').match(/https?:\/\/[^\s,;]+/g)||[])].map(linkedinUrl).filter(Boolean);
            const participantIds=[...new Set(urls.map(u=>peopleByProfile.get(u)).filter(Boolean))];
            touchValues.push(`(${q(id)}::uuid,'message','linkedin-message',${q(owner)},${q(key)},${q(accounts[0].member_id)}::uuid,${q(raw.SUBJECT||raw['CONVERSATION TITLE']||`LinkedIn message from ${raw.FROM||'a connection'}`)},${q(occurred)}::timestamptz,${q(raw.CONTENT||'')},${q(urls.find(u=>!selfUrls.has(u))||null)},'LinkedIn message',${json({archive_id:archiveId,source_file:sourceFile,row_number:j+1,from:raw.FROM,to:raw.TO,conversation_id:raw['CONVERSATION ID'],attachments:raw.ATTACHMENTS,source_date:raw.DATE})})`);
            for(const p of participantIds)linkValues.push(`(${q(id)}::uuid,${q(p)}::uuid)`);
          }
          sqlBytes+=[...rawValues.slice(byteStart[0]),...touchValues.slice(byteStart[1]),...linkValues.slice(byteStart[2])].reduce((n,s)=>n+Buffer.byteLength(s),0);
        }
        if(!batchRows)continue;
        const statements=[`INSERT INTO crm_import_rows(archive_id,source_file,row_number,raw,person_id) VALUES ${rawValues.join(',')} ON CONFLICT DO NOTHING;`];
        if(touchValues.length)statements.push(`INSERT INTO crm_touchpoints(touchpoint_id,kind,source,source_account,external_id,owner_id,title,occurred_at,body,source_url,classification,raw) VALUES ${touchValues.join(',')} ON CONFLICT DO NOTHING;`);
        if(linkValues.length)statements.push(`INSERT INTO crm_touchpoint_people(touchpoint_id,person_id) VALUES ${linkValues.join(',')} ON CONFLICT DO NOTHING;`);
        await executeSql('BEGIN;'+statements.join('\n')+'COMMIT;',{application:'portomatic_crm_linkedin'});
        totalRows+=batchRows;
        await fs.writeFile(path.join(stateDir,'linkedin-progress.json'),JSON.stringify({phase:'history',file:r.source_filename,done:totalRows,total:Object.values(counts).reduce((n,v)=>n+v,0)}));
      }
    }
    const check=await queryRows(`SELECT source_file,count(*) AS rows FROM crm_import_rows WHERE archive_id=${q(archiveId)}::uuid GROUP BY source_file;`);
    for(const [file,count] of Object.entries(counts))if(Number(check.find(c=>c.source_file===file)?.rows)!==count)throw new Error('LinkedIn raw row completeness mismatch: '+file);
    await sourceStatus(owner,'linkedin',owner,'connected',{success:true,metadata:{archive_id:archiveId,storage_uri:r.storage_uri,row_counts:counts,scope:'Downloaded export snapshot; not a live LinkedIn connection'}});
    const receipt={...r,archive_id:archiveId,owner_email:owner,row_counts:counts,verified_rows:totalRows,verified_at:new Date().toISOString()};
    await fs.writeFile(path.join(stateDir,`linkedin-${archiveId}.receipt.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    await fs.writeFile(path.join(stateDir,'linkedin-progress.json'),JSON.stringify({phase:'complete',file:r.source_filename,done:totalRows,total:totalRows}));
    return receipt;
  }catch(error){await sourceStatus(owner,'linkedin',owner,'error',{error:error.message});throw error;}
}
