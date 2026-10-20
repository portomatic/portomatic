import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appDir,stateDir,settings} from './config.mjs';
import {queryRows as queryOnce,executeSql as executeOnce,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';
import {email,json,sourceStatus} from './store.mjs';
import {stableId} from './archive.mjs';
import crypto from 'node:crypto';

const exec=promisify(execFile);
const directory=path.join(stateDir,'imessage');
const configPath=path.join(directory,'sync-config.json');
const statusPath=path.join(directory,'sync-status.json');

async function retryCloud(work){
  for(let attempt=0;;attempt++){
    try{return await work();}catch(error){
      if(!/429|Quota exceeded|RESOURCE_EXHAUSTED/.test(error.message)||attempt>=8)throw error;
      console.error(JSON.stringify({phase:'cloud_sql_backoff',attempt:attempt+1}));
      await new Promise(resolve=>setTimeout(resolve,Math.min(60000,15000*(attempt+1))));
    }
  }
}
const queryRows=(sql,options)=>retryCloud(()=>queryOnce(sql,options));
const executeSql=(sql,options)=>retryCloud(()=>executeOnce(sql,options));
const contactFingerprint=c=>crypto.createHash('sha256').update(JSON.stringify([c.personId,c.name,c.emails,c.phones,c.basis,c.outreachSuppressed,c.preferredChannel||null])).digest('hex');

async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function privateJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+process.pid+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await fs.rename(temporary,file);
}

export async function configureImessageSync({mode,enabled=true,ownerEmail=settings().ownerEmail}={}){
  if(!['text','metadata'].includes(mode))throw new Error('Use --mode text or --mode metadata');
  const config={version:1,enabled,mode,ownerEmail:email(ownerEmail),intervalSeconds:60,classifyNewContacts:true,configuredAt:new Date().toISOString()};
  await privateJson(configPath,config);return config;
}

export async function initImessageSchema(){
  const migration=path.resolve(appDir,'../../customers/migrations/020_crm_imessage.sql');
  await executeSql(await fs.readFile(migration,'utf8'),{bootstrap:true,application:'portomatic_imessage_migration'});
  return {initialized:true};
}

export function resolveMessageContacts(contacts,{emails=[],phones=[],mappings=[]}={}){
  const mail=new Map(emails.map(v=>[v.email,v.person_id]));
  const phone=new Map(phones.map(v=>[v.phone,v.person_id]));
  const mapping=new Map(mappings.map(v=>[v.contact_id,v.person_id]));
  const resolved=[],conflicts=[];
  for(const c of contacts){
    const candidates=new Set([mapping.get(c.id),...c.identifiers.map(v=>v.includes('@')?mail.get(v.toLowerCase()):phone.get(v))].filter(Boolean));
    if(candidates.size>1){conflicts.push(c.id);continue;}
    const personId=[...candidates][0]||stableId('imessage-person:'+c.id);
    // Name similarity is deliberately never used to merge people.
    const value={...c,personId,emails:c.identifiers.filter(v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)).map(v=>v.toLowerCase()),phones:c.identifiers.filter(v=>/^\+\d+$/.test(v))};
    resolved.push(value);
    for(const e of value.emails)mail.set(e,personId);
    for(const p of value.phones)phone.set(p,personId);
  }
  return {contacts:resolved,conflicts};
}

export function messageRows(contacts,owner,mode,policyHash){
  const seen=new Set(),rows=[];
  for(const c of contacts)for(const m of c.messages){
    if(!m.guid||seen.has(m.guid)||!Number.isFinite(Date.parse(m.date))||!['incoming','outgoing'].includes(m.direction)||!m.fingerprint)throw new Error('Invalid or duplicate source message');
    seen.add(m.guid);
    rows.push({id:stableId('imessage:'+owner+':'+m.guid),guid:m.guid,contact_id:c.id,person_id:c.personId,title:'iMessage with '+(c.name==='Unsaved contact'?(c.phones[0]||c.emails[0]||'unnamed contact'):c.name),date:m.date,body:mode==='text'?m.text:'',raw:{imessage_contact_id:c.id,direction:m.direction,source_fingerprint:m.fingerprint,import_mode:mode,policy_hash:policyHash}});
  }
  return rows;
}

export function batches(rows,{maxRows=500,maxBytes=150000}={}){
  const output=[];let current=[],size=0;
  for(const row of rows){
    const bytes=Buffer.byteLength(JSON.stringify(row));
    if(current.length&&(current.length>=maxRows||size+bytes>maxBytes)){output.push(current);current=[];size=0;}
    current.push(row);size+=bytes;
  }
  if(current.length)output.push(current);
  return output;
}

function contactSql(contacts,ownerId){
  const input=contacts.map(c=>({person_id:c.personId,contact_id:c.id,name:c.name==='Unsaved contact'?(c.phones[0]||c.emails[0]||'Unnamed iMessage contact'):c.name,emails:c.emails,phones:c.phones,basis:c.basis,outreach_suppressed:c.outreachSuppressed,preferred_channel:c.preferredChannel||null,fingerprint:contactFingerprint(c)}));
  const from=`jsonb_to_recordset(${json(input)}) AS x(person_id uuid,contact_id text,name text,emails jsonb,phones jsonb,basis text,outreach_suppressed boolean,preferred_channel text,fingerprint text)`;
  return `INSERT INTO crm_people(person_id,name) SELECT DISTINCT ON (person_id) person_id,name FROM ${from} ON CONFLICT(person_id) DO NOTHING;
    INSERT INTO crm_person_emails(email,person_id,provenance) SELECT e,person_id,'imessage:exact-address-book-alias' FROM ${from} CROSS JOIN LATERAL jsonb_array_elements_text(emails) e ON CONFLICT(email) DO NOTHING;
    INSERT INTO crm_person_phones(phone,person_id,provenance) SELECT p,person_id,'imessage:exact-address-book-alias' FROM ${from} CROSS JOIN LATERAL jsonb_array_elements_text(phones) p ON CONFLICT(phone) DO NOTHING;
    INSERT INTO crm_imessage_contacts(owner_id,contact_id,person_id,decision_basis,outreach_suppressed,preferred_channel,contact_fingerprint)
      SELECT ${q(ownerId)}::uuid,contact_id,person_id,basis,outreach_suppressed,preferred_channel,fingerprint FROM ${from}
      ON CONFLICT(owner_id,contact_id) DO UPDATE SET person_id=excluded.person_id,decision_basis=excluded.decision_basis,outreach_suppressed=excluded.outreach_suppressed,preferred_channel=excluded.preferred_channel,contact_fingerprint=excluded.contact_fingerprint,last_synced_at=now() WHERE crm_imessage_contacts.person_id=excluded.person_id OR EXISTS(SELECT 1 FROM crm_people p WHERE p.person_id=crm_imessage_contacts.person_id AND p.merged_into=excluded.person_id);`;
}

export function messageSql(rows,ownerId,owner){
  const from=`jsonb_to_recordset(${json(rows)}) AS x(id uuid,guid text,contact_id text,person_id uuid,title text,date timestamptz,body text,raw jsonb)`;
  return `WITH saved AS (INSERT INTO crm_touchpoints(touchpoint_id,kind,source,source_account,external_id,owner_id,title,occurred_at,body,classification,raw)
    SELECT id,'message','imessage',${q(owner)},guid,${q(ownerId)}::uuid,title,date,body,'business or mixed contact',raw FROM ${from}
    ON CONFLICT(source,source_account,external_id) DO UPDATE SET body=excluded.body,title=excluded.title,occurred_at=excluded.occurred_at,owner_id=excluded.owner_id,classification=excluded.classification,raw=excluded.raw,updated_at=now()
    RETURNING touchpoint_id,external_id)
    INSERT INTO crm_touchpoint_people(touchpoint_id,person_id,role) SELECT s.touchpoint_id,x.person_id,'correspondent' FROM saved s JOIN ${from} ON x.guid=s.external_id ON CONFLICT DO NOTHING;`;
}

async function transaction(sql){return executeSql('BEGIN; SELECT pg_advisory_xact_lock(519201001); '+sql+' COMMIT;',{application:'portomatic_imessage_sync'});}

export async function syncImessage({mode,dryRun=false,classifyNew}={}){
  const config=await readJson(configPath,null);
  if(!config?.enabled&&!mode)return {enabled:false};
  mode=mode||config.mode;
  if(!['text','metadata'].includes(mode))throw new Error('Configure the iMessage sync mode first');
  const owner=email(config?.ownerEmail||settings().ownerEmail);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const lockPath=path.join(directory,'sync.lock');
  let lock;
  try{lock=await fs.open(lockPath,'wx',0o600);}catch(e){
    if(e.code!=='EEXIST')throw e;
    const previous=await readJson(lockPath,{});
    try{process.kill(previous.pid,0);return {running:true};}catch(check){if(check.code!=='ESRCH')throw new Error('Cannot establish whether another sync is running');}
    await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx',0o600);
  }
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  const startedAt=new Date().toISOString();let phase='local_snapshot';
  try{
    const localPython=path.join(directory,'../imessage-research-venv/bin/python');
    const args=[path.join(appDir,'scripts/imessage_sync.py'),'--mode',mode];
    if(classifyNew??(!dryRun&&config?.classifyNewContacts))args.push('--classify-new');
    await exec(process.env.PORTOMATIC_IMESSAGE_PYTHON||localPython,args,{maxBuffer:1024*1024,timeout:10*60*1000});
    const snapshot=await readJson(path.join(directory,'sync-export.json'));
    if(snapshot.version!==1||snapshot.mode!==mode||!Array.isArray(snapshot.contacts)||!snapshot.policyHash)throw new Error('Invalid filtered source snapshot');
    if(dryRun)return {dryRun:true,mode,counts:snapshot.counts,scope:snapshot.scope};
    phase='cloud_identity';
    const members=await queryRows(`SELECT member_id FROM crm_members WHERE email=${q(owner)};`);
    if(members.length!==1)throw new Error('Sync owner is not a CRM member');
    const ownerId=members[0].member_id;
    const data=await queryRows(`SELECT jsonb_build_object(
      'emails',(SELECT coalesce(jsonb_agg(jsonb_build_object('email',e.email,'person_id',coalesce(p.merged_into,p.person_id))),'[]') FROM crm_person_emails e JOIN crm_people p USING(person_id)),
      'phones',(SELECT coalesce(jsonb_agg(jsonb_build_object('phone',e.phone,'person_id',coalesce(p.merged_into,p.person_id))),'[]') FROM crm_person_phones e JOIN crm_people p USING(person_id)),
      'mappings',(SELECT coalesce(jsonb_agg(jsonb_build_object('contact_id',e.contact_id,'person_id',coalesce(p.merged_into,p.person_id),'fingerprint',e.contact_fingerprint)),'[]') FROM crm_imessage_contacts e JOIN crm_people p USING(person_id) WHERE owner_id=${q(ownerId)}::uuid),
      'messages',(SELECT coalesce(jsonb_agg(jsonb_build_object('guid',external_id,'fingerprint',raw->>'source_fingerprint','contact_id',raw->>'imessage_contact_id')),'[]') FROM crm_touchpoints WHERE source='imessage' AND source_account=${q(owner)})
      )::text AS data;`,{rowLimit:1});
    const cloud=typeof data[0].data==='string'?JSON.parse(data[0].data):data[0].data;
    const resolved=resolveMessageContacts(snapshot.contacts,cloud);
    const retained=new Set([...snapshot.retainedContactIds,...resolved.conflicts]);
    const rows=messageRows(resolved.contacts,owner,mode,snapshot.policyHash);
    const existing=new Map(cloud.messages.map(m=>[m.guid,m]));
    const current=new Set(rows.map(m=>m.guid));
    const changed=rows.filter(m=>existing.get(m.guid)?.fingerprint!==m.raw.source_fingerprint);
    const deleted=cloud.messages.filter(m=>!current.has(m.guid)&&!retained.has(m.contact_id)).map(m=>m.guid);
    phase='cloud_contacts';
    const mapped=new Map(cloud.mappings.map(c=>[c.contact_id,c]));
    const changedContacts=resolved.contacts.filter(c=>mapped.get(c.id)?.fingerprint!==contactFingerprint(c));
    for(const batch of batches(changedContacts,{maxRows:100}))await transaction(contactSql(batch,ownerId));
    phase='cloud_messages';
    let written=0;
    for(const batch of batches(changed)){
      await transaction(messageSql(batch,ownerId,owner));written+=batch.length;
      if(written%3000<batch.length)console.error(JSON.stringify({phase:'imessage_backfill',written,total:changed.length}));
    }
    phase='cloud_reconcile';
    for(const batch of batches(deleted,{maxRows:500})){
      const where=`source='imessage' AND source_account=${q(owner)} AND external_id IN (${batch.map(q).join(',')})`;
      await transaction(`DELETE FROM crm_touchpoint_people WHERE touchpoint_id IN (SELECT touchpoint_id FROM crm_touchpoints WHERE ${where}); DELETE FROM crm_touchpoints WHERE ${where};`);
    }
    const allowed=resolved.contacts.map(c=>c.id);
    const allowedSet=new Set([...allowed,...retained]);
    const revokedMappings=cloud.mappings.filter(c=>!allowedSet.has(c.contact_id));
    if(revokedMappings.length){
      const orphanCandidates=revokedMappings.filter(c=>c.person_id===stableId('imessage-person:'+c.contact_id)).map(c=>c.person_id);
      let cleanup='';
      if(orphanCandidates.length){
        // Remove only profiles created by this importer with no remaining history
        // or independent CRM evidence. Other sources' people remain untouched.
        const candidates=`SELECT p.person_id FROM crm_people p WHERE p.person_id=ANY(ARRAY[${orphanCandidates.map(q).join(',')}]::uuid[]) AND p.relationship='unknown' AND p.legacy_customer_id IS NULL AND p.merged_into IS NULL AND p.notes='' AND NOT EXISTS(SELECT 1 FROM crm_touchpoint_people t WHERE t.person_id=p.person_id) AND NOT EXISTS(SELECT 1 FROM crm_imessage_contacts c WHERE c.person_id=p.person_id) AND NOT EXISTS(SELECT 1 FROM crm_person_profiles pr WHERE pr.person_id=p.person_id) AND NOT EXISTS(SELECT 1 FROM crm_import_rows ir WHERE ir.person_id=p.person_id) AND NOT EXISTS(SELECT 1 FROM crm_company_person_links cp WHERE cp.person_id=p.person_id) AND NOT EXISTS(SELECT 1 FROM crm_people other WHERE other.merged_into=p.person_id) AND NOT EXISTS(SELECT 1 FROM crm_person_emails e WHERE e.person_id=p.person_id AND e.provenance NOT LIKE 'imessage:%') AND NOT EXISTS(SELECT 1 FROM crm_person_phones ph WHERE ph.person_id=p.person_id AND ph.provenance NOT LIKE 'imessage:%')`;
        cleanup=`CREATE TEMP TABLE imessage_orphans ON COMMIT DROP AS ${candidates}; DELETE FROM crm_person_emails WHERE person_id IN(SELECT person_id FROM imessage_orphans); DELETE FROM crm_person_phones WHERE person_id IN(SELECT person_id FROM imessage_orphans); DELETE FROM crm_people WHERE person_id IN(SELECT person_id FROM imessage_orphans);`;
      }
      await transaction(`DELETE FROM crm_imessage_contacts WHERE owner_id=${q(ownerId)}::uuid AND NOT (contact_id=ANY(ARRAY[${[...allowedSet].map(q).join(',')}]::text[])); ${cleanup}`);
    }
    phase='cloud_verify';
    const verify=await queryRows(`SELECT count(*) AS messages,count(DISTINCT raw->>'imessage_contact_id') AS contacts,count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM crm_touchpoint_people p WHERE p.touchpoint_id=t.touchpoint_id)) AS unlinked,md5(coalesce(string_agg(external_id||':'||(raw->>'source_fingerprint'),'|' ORDER BY external_id COLLATE "C"),'')) AS fingerprint FROM crm_touchpoints t WHERE source='imessage' AND source_account=${q(owner)};`);
    const expectedRows=[...rows.map(m=>({guid:m.guid,fingerprint:m.raw.source_fingerprint})),...cloud.messages.filter(m=>!current.has(m.guid)&&retained.has(m.contact_id))];
    const expectedFingerprint=crypto.createHash('md5').update(expectedRows.sort((a,b)=>a.guid<b.guid?-1:a.guid>b.guid?1:0).map(m=>m.guid+':'+m.fingerprint).join('|')).digest('hex');
    if(Number(verify[0].messages)!==expectedRows.length||Number(verify[0].unlinked)!==0||verify[0].fingerprint!==expectedFingerprint)throw new Error('Cloud verification counts or fingerprints did not match the filtered source');
    const result={enabled:config?.enabled||false,status:retained.size?'partial':'connected',startedAt,finishedAt:new Date().toISOString(),mode,ownerEmail:owner,contacts:resolved.contacts.length,messages:rows.length,written,unchanged:rows.length-changed.length,removed:deleted.length,heldContacts:retained.size,identityConflicts:resolved.conflicts.length,sourceCounts:snapshot.counts,cloudVerifiedMessages:Number(verify[0].messages),cloudVerifiedContacts:Number(verify[0].contacts),policyHash:snapshot.policyHash,scope:snapshot.scope};
    await retryCloud(()=>sourceStatus(owner,'imessage',owner,'connected',{success:true,metadata:{scope:result.scope,mode,contacts:result.contacts,messages:result.messages,held_contacts:retained.size,policy_hash:snapshot.policyHash},cursor:{last_success_at:result.finishedAt}}));
    await privateJson(statusPath,result);return result;
  }catch(error){
    await privateJson(statusPath,{enabled:config?.enabled||false,status:'error',startedAt,failedAt:new Date().toISOString(),phase,error:'Sync failed during '+phase+' ('+(error.code||error.name||'error')+')'});
    throw error;
  }finally{await lock.close();await fs.unlink(lockPath).catch(()=>{});}
}

export async function imessageSyncStatus(){return {config:await readJson(configPath,{enabled:false}),lastRun:await readJson(statusPath,null)};}
