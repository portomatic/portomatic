import {queryRows,executeSql,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';
import crypto from 'node:crypto';
import {automaticMeeting} from './matching.mjs';
import {loadMediaConfig} from '../../../media/scripts/lib/config.mjs';

export const json = value => `${q(JSON.stringify(value))}::jsonb`;
export const uuid = value => {
  if(!/^[a-f0-9-]{36}$/i.test(String(value))) throw new Error('Invalid record ID');
  return q(value)+'::uuid';
};
export const email = value => {
  const e=String(value||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Enter a valid email address');
  return e;
};
const parse = value => typeof value==='string'?JSON.parse(value):value;
const tx = sql => executeSql(`BEGIN; SELECT pg_advisory_xact_lock(519201001); ${sql} COMMIT;`,{application:'portomatic_crm'});

export async function initMembers(){
  const principals=loadMediaConfig().founderPrincipals.split(',').filter(v=>v.startsWith('user:'));
  await tx(principals.map(p=>{
    const e=email(p.slice(5)),name=e.split('@')[0].replace(/^./,c=>c.toUpperCase());
    return `INSERT INTO crm_members(email,name) VALUES (${q(e)},${q(name)}) ON CONFLICT(email) DO NOTHING;
      INSERT INTO crm_sources(owner_id,provider,account) SELECT member_id,v,${q(e)} FROM crm_members CROSS JOIN unnest(ARRAY['gmail','calendar','drive','recordings']) v WHERE email=${q(e)} ON CONFLICT DO NOTHING;`;
  }).join('\n'));
}

export async function getMembers(){return await queryRows('SELECT member_id,email,name FROM crm_members ORDER BY name;');}

export async function state({search='',person='',kind='',owner='',limit=150,view='all'}={}){
  const where=['true'];
  if(search)where.push(`(t.search_document @@ websearch_to_tsquery('english',${q(search)}) OR t.title ILIKE ${q('%'+search+'%')} OR EXISTS(SELECT 1 FROM crm_touchpoint_people tp JOIN crm_people p USING(person_id) LEFT JOIN crm_person_emails pe USING(person_id) WHERE tp.touchpoint_id=t.touchpoint_id AND (p.name ILIKE ${q('%'+search+'%')} OR p.company ILIKE ${q('%'+search+'%')} OR pe.email ILIKE ${q('%'+search+'%')})))`);
  if(person)where.push(`EXISTS(SELECT 1 FROM crm_touchpoint_people tp WHERE tp.touchpoint_id=t.touchpoint_id AND tp.person_id=${uuid(person)})`);
  if(kind){if(!['email','meeting','recording','document','note','connection','message'].includes(kind))throw new Error('Invalid timeline type');where.push(`t.kind=${q(kind)}`);}
  if(owner)where.push(`t.owner_id=${uuid(owner)}`);
  const includePeople=!!person||['all','people'].includes(view),includeTimeline=view!=='connections'&&(view!=='people'||!!person);
  const peopleWhere=!includePeople?'false':person?`p.person_id=${uuid(person)}`:search?`(p.name ILIKE ${q('%'+search+'%')} OR p.company ILIKE ${q('%'+search+'%')} OR p.position ILIKE ${q('%'+search+'%')} OR EXISTS(SELECT 1 FROM crm_person_emails e WHERE e.person_id=p.person_id AND e.email ILIKE ${q('%'+search+'%')}) OR EXISTS(SELECT 1 FROM crm_person_profiles pr WHERE pr.person_id=p.person_id AND pr.profile_url ILIKE ${q('%'+search+'%')}))`:'true';
  const rows=await queryRows(`WITH selected_people AS MATERIALIZED (
    SELECT p.* FROM crm_people p WHERE p.merged_into IS NULL AND ${peopleWhere} ORDER BY p.name LIMIT 500
  ), person_emails AS (
    SELECT person_id,jsonb_agg(email ORDER BY email) AS emails FROM crm_person_emails JOIN selected_people USING(person_id) GROUP BY person_id
  ), person_profiles AS (
    SELECT person_id,jsonb_agg(jsonb_build_object('platform',platform,'url',profile_url)) AS profiles FROM crm_person_profiles JOIN selected_people USING(person_id) GROUP BY person_id
  ), person_activity AS (
    SELECT tp.person_id,count(*) AS touchpoints,max(t.occurred_at) FILTER(WHERE t.occurred_at<=now()) AS last_touch
    FROM crm_touchpoint_people tp JOIN selected_people p USING(person_id) JOIN crm_touchpoints t USING(touchpoint_id) GROUP BY tp.person_id
  ) SELECT jsonb_build_object(
    'members',(SELECT coalesce(jsonb_agg(x ORDER BY x.name),'[]') FROM (SELECT member_id,email,name FROM crm_members) x),
    'people',(SELECT coalesce(jsonb_agg(x ORDER BY x.last_touch DESC NULLS LAST,x.name),'[]') FROM (
      SELECT p.*,coalesce(e.emails,'[]') AS emails,coalesce(pr.profiles,'[]') AS profiles,
      coalesce(a.touchpoints,0) AS touchpoints,a.last_touch
      FROM selected_people p LEFT JOIN person_emails e USING(person_id) LEFT JOIN person_profiles pr USING(person_id)
      LEFT JOIN person_activity a USING(person_id) WHERE p.merged_into IS NULL) x),
    'timeline',(SELECT coalesce(jsonb_agg(x ORDER BY x.occurred_at DESC),'[]') FROM (SELECT t.touchpoint_id,t.kind,t.source,t.source_account,t.external_id,t.title,t.occurred_at,t.ends_at,t.body,t.source_url,t.storage_uri,t.classification,t.owner_id,t.owner_name,t.owner_email,t.people,
      t.raw->>'transcript_status' AS transcript_status,t.raw->>'bytes' AS bytes,t.raw->>'duration_ms' AS duration_ms,t.raw->>'manifest_uri' AS manifest_uri,
      (SELECT j.status FROM crm_transcription_jobs j WHERE j.touchpoint_id=t.touchpoint_id ORDER BY j.created_at DESC LIMIT 1) AS transcription_job_status,
      (SELECT tr.run_id FROM crm_transcripts tr WHERE tr.touchpoint_id=t.touchpoint_id AND tr.is_current) AS transcript_run_id,
      (SELECT j.status FROM crm_sales_feedback_jobs j JOIN crm_transcripts tr USING(run_id) WHERE tr.touchpoint_id=t.touchpoint_id AND tr.is_current ORDER BY j.created_at DESC LIMIT 1) AS sales_feedback_status,
      (SELECT jsonb_agg(n.name ORDER BY n.name) FROM (SELECT DISTINCT a.name FROM crm_transcripts tr JOIN crm_speaker_jobs j ON j.run_id=tr.run_id AND j.is_current AND j.status='complete' JOIN crm_speaker_assignments a ON a.job_id=j.job_id AND a.lease_token=j.lease_token WHERE tr.touchpoint_id=t.touchpoint_id AND tr.is_current) n) AS inferred_speakers,
      (SELECT l.recording_id FROM crm_links l WHERE l.meeting_id=t.touchpoint_id AND l.status IN ('confirmed','automatic') ORDER BY (l.status='confirmed') DESC, l.created_at LIMIT 1) AS recording_link,
      coalesce(t.raw->>'source_status',CASE WHEN t.raw->>'status'='cancelled' THEN 'Cancelled' WHEN t.raw->>'trashed'='true' THEN 'Trashed in Drive' END) AS source_status
      FROM crm_timeline t WHERE ${includeTimeline?where.join(' AND '):'false'} ORDER BY t.occurred_at DESC LIMIT ${Math.min(500,Math.max(1,Number(limit)||150))}) x),
    'sources',(SELECT coalesce(jsonb_agg(x ORDER BY x.owner_name,x.provider),'[]') FROM (SELECT s.*,m.name AS owner_name,m.email AS owner_email FROM crm_sources s JOIN crm_members m ON s.owner_id=m.member_id) x),
    'counts',jsonb_build_object('people',(SELECT count(*) FROM crm_people WHERE relationship<>'founder' AND merged_into IS NULL),'touchpoints',(SELECT count(*) FROM crm_touchpoints),'recordings',(SELECT count(*) FROM crm_touchpoints WHERE kind='recording'),'unlinked_recordings',(SELECT count(*) FROM crm_touchpoints t WHERE t.kind='recording' AND NOT EXISTS(SELECT 1 FROM crm_links l WHERE l.recording_id=t.touchpoint_id AND l.status IN ('confirmed','automatic'))))
  )::text AS data;`,{rowLimit:1});
  return parse(rows[0].data);
}

export async function findPeople(search=''){
  return await queryRows(`SELECT p.person_id,p.name,p.company,
    coalesce((SELECT jsonb_agg(email) FROM crm_person_emails e WHERE e.person_id=p.person_id),'[]') AS emails
    FROM crm_people p WHERE p.merged_into IS NULL AND (p.name ILIKE ${q('%'+search+'%')} OR p.company ILIKE ${q('%'+search+'%')}
      OR EXISTS(SELECT 1 FROM crm_person_emails e WHERE e.person_id=p.person_id AND e.email ILIKE ${q('%'+search+'%')})) ORDER BY p.name LIMIT 40;`);
}

export async function markSourceUnavailable(source,account,ids,status){
  if(!ids.length)return;
  await executeSql(`UPDATE crm_touchpoints SET raw=raw || ${json({source_status:status})},updated_at=now()
    WHERE source=${q(source)} AND source_account=${q(account)} AND external_id IN (${ids.map(q).join(',')});`,{application:'portomatic_crm_sync'});
}

export async function sourceStatus(owner,provider,account,status,{error=null,cursor=null,metadata=null,success=false}={}){
  await executeSql(`INSERT INTO crm_sources(owner_id,provider,account,status,last_attempt_at,last_success_at,error,cursor,metadata)
    SELECT member_id,${q(provider)},${q(account)},${q(status)},now(),${success?'now()':'NULL'},${q(error)},${json(cursor||{})},${json(metadata||{})} FROM crm_members WHERE email=${q(email(owner))}
    ON CONFLICT(owner_id,provider,account) DO UPDATE SET status=excluded.status,last_attempt_at=now(),error=excluded.error,
      last_success_at=${success?'now()':'crm_sources.last_success_at'},cursor=${cursor?'excluded.cursor':'crm_sources.cursor'},metadata=${metadata?'crm_sources.metadata || excluded.metadata':'crm_sources.metadata'};`,{application:'portomatic_crm_sync'});
}

export async function importItems({ownerEmail,source,account,items}){
  const owner=ownerEmail?email(ownerEmail):null;
  if(!Array.isArray(items)||items.length>500)throw new Error('Import up to 500 touchpoints per batch');
  const contacts=new Map();
  for(const item of items)for(const p of item.participants||[]){const e=email(p.email);contacts.set(e,{...p,email:e});}
  const sql=[];
  for(const [e,p] of [...contacts].sort(([a],[b])=>a.localeCompare(b))){
    sql.push(`WITH new_person AS (INSERT INTO crm_people(name,company,relationship)
      SELECT ${q(p.name?.trim()||e)},${q(p.company||null)},CASE WHEN EXISTS(SELECT 1 FROM crm_members WHERE email=${q(e)}) THEN 'founder' ELSE 'unknown' END
      WHERE NOT EXISTS(SELECT 1 FROM crm_person_emails WHERE email=${q(e)}) RETURNING person_id)
      INSERT INTO crm_person_emails(email,person_id,provenance) SELECT ${q(e)},person_id,${q(source+':'+account)} FROM new_person ON CONFLICT(email) DO NOTHING;`);
  }
  for(const item of items){
    if(!['email','meeting','recording','document','note','connection','message'].includes(item.kind)||!item.externalId||!item.title||!Number.isFinite(Date.parse(item.occurredAt)))throw new Error('Touchpoint requires type, source ID, title, and date');
    const idWhere=`source=${q(source)} AND source_account=${q(account||'')} AND external_id=${q(item.externalId)}`;
    sql.push(`INSERT INTO crm_touchpoints(kind,source,source_account,external_id,owner_id,title,occurred_at,ends_at,body,source_url,storage_uri,classification,raw)
      VALUES (${q(item.kind)},${q(source)},${q(account||'')},${q(item.externalId)},${owner?`(SELECT member_id FROM crm_members WHERE email=${q(owner)})`:'NULL'},${q(item.title)},${q(item.occurredAt)}::timestamptz,${q(item.endsAt||null)}::timestamptz,${q(item.body||'')},${q(item.url||null)},${q(item.storageUri||null)},${q(item.classification||null)},${json(item.raw||{})})
      ON CONFLICT(source,source_account,external_id) DO UPDATE SET title=excluded.title,occurred_at=excluded.occurred_at,ends_at=excluded.ends_at,body=excluded.body,source_url=excluded.source_url,owner_id=coalesce(excluded.owner_id,crm_touchpoints.owner_id),raw=excluded.raw,updated_at=now();`);
    for(const p of item.participants||[])sql.push(`INSERT INTO crm_touchpoint_people(touchpoint_id,person_id,role) SELECT t.touchpoint_id,e.person_id,${q(p.role||'participant')} FROM crm_touchpoints t CROSS JOIN crm_person_emails e WHERE t.${idWhere.replaceAll(' AND ',' AND t.')} AND e.email=${q(email(p.email))} ON CONFLICT DO NOTHING;`);
  }
  sql.push(`INSERT INTO crm_audit_log(action,detail) VALUES ('import',${json({source,account,owner,count:items.length})});`);
  await tx(sql.join('\n'));
  await suggestLinks();
  return {imported:items.length};
}

export async function refreshArchive(){
  await refreshCallCatalog();
  // A URI is one raw source, even if several founders synchronize the catalog.
  await tx(`INSERT INTO crm_touchpoints(kind,source,external_id,title,occurred_at,ends_at,storage_uri,classification,raw)
    SELECT 'recording','media-archive',a.asset_id::text,a.source_filename,a.captured_at,a.captured_at+(coalesce(a.duration_ms,0)*interval '1 millisecond'),a.storage_uri,a.classification,
      jsonb_build_object('asset_id',a.asset_id,'sha256',a.sha256,'bytes',a.bytes,'duration_ms',a.duration_ms,'object_generation',a.object_generation,'manifest_uri',a.manifest_uri,'manifest_generation',a.manifest_generation,'source_filename',a.source_filename)
    FROM media_archive_assets a WHERE a.classification LIKE 'business-conversation%' OR a.classification='business-conversation'
    ON CONFLICT(source,source_account,external_id) DO NOTHING;`);
  await suggestLinks();
}

export async function refreshCallCatalog(){
  await tx(`
    INSERT INTO crm_people(person_id,name,company,legacy_customer_id)
      SELECT customer_id,name,company,customer_id FROM customers ON CONFLICT(legacy_customer_id) DO NOTHING;
    INSERT INTO crm_touchpoints(kind,source,external_id,title,occurred_at,body,classification,raw)
      SELECT 'meeting','customer-call',c.call_id,c.title,c.recorded_at,coalesce(c.notes,''),'historical conversation',jsonb_build_object('call_id',c.call_id,'provenance','Cloud SQL customer-call catalog; customer relationship is not implied.')
      FROM active_calls c ON CONFLICT(source,source_account,external_id) DO UPDATE SET title=excluded.title,occurred_at=excluded.occurred_at,body=excluded.body;
    INSERT INTO crm_touchpoint_people(touchpoint_id,person_id)
      SELECT t.touchpoint_id,coalesce(p.merged_into,p.person_id) FROM crm_touchpoints t JOIN active_calls c ON t.source='customer-call' AND t.external_id=c.call_id JOIN crm_people p ON p.legacy_customer_id=c.primary_customer_id ON CONFLICT DO NOTHING;
    INSERT INTO crm_touchpoints(kind,source,external_id,title,occurred_at,ends_at,storage_uri,classification,raw)
      SELECT 'recording','customer-recording',ro.recording_id::text,coalesce(ro.source_title,ro.source_filename),ro.recorded_at,
      ro.recorded_at+(ro.duration_ms*interval '1 millisecond'),ro.storage_uri,'historical recording',jsonb_build_object('recording_id',ro.recording_id,'sha256',ro.sha256,'bytes',ro.bytes,'duration_ms',ro.duration_ms,'object_generation',ro.object_generation,'source_filename',ro.source_filename)
      FROM recording_objects ro ON CONFLICT(source,source_account,external_id) DO NOTHING;
    INSERT INTO crm_touchpoint_people(touchpoint_id,person_id)
      SELECT DISTINCT t.touchpoint_id,coalesce(p.merged_into,p.person_id) FROM crm_touchpoints t JOIN active_call_recordings cr ON t.source='customer-recording' AND t.external_id=cr.recording_id::text
      JOIN calls c USING(call_id) JOIN crm_people p ON p.legacy_customer_id=c.primary_customer_id ON CONFLICT DO NOTHING;
    INSERT INTO crm_links(recording_id,meeting_id,status,reason,reviewed_at)
      SELECT DISTINCT r.touchpoint_id,m.touchpoint_id,'confirmed','Existing active_call_recordings foreign-key relationship',now()
      FROM active_call_recordings cr JOIN crm_touchpoints r ON r.source='customer-recording' AND r.external_id=cr.recording_id::text JOIN crm_touchpoints m ON m.source='customer-call' AND m.external_id=cr.call_id ON CONFLICT DO NOTHING;
  `);
}

export async function mergePeople(fromId,toId,provenance='Manual identity correction'){
  if(fromId===toId)throw new Error('Choose another person to merge');
  await tx(`DO $$ BEGIN IF (SELECT count(*) FROM crm_people WHERE person_id IN (${uuid(fromId)},${uuid(toId)}) AND merged_into IS NULL)<>2 THEN RAISE EXCEPTION 'Both people must exist and be unmerged'; END IF; END $$;
    INSERT INTO crm_touchpoint_people(touchpoint_id,person_id,role) SELECT touchpoint_id,${uuid(toId)},role FROM crm_touchpoint_people WHERE person_id=${uuid(fromId)} ON CONFLICT DO NOTHING;
    DELETE FROM crm_touchpoint_people WHERE person_id=${uuid(fromId)};
    UPDATE crm_person_emails SET person_id=${uuid(toId)} WHERE person_id=${uuid(fromId)};
    UPDATE crm_person_profiles SET person_id=${uuid(toId)} WHERE person_id=${uuid(fromId)};
    UPDATE crm_people target SET company=coalesce(target.company,source.company),position=coalesce(target.position,source.position),notes=concat_ws(E'\\n',nullif(target.notes,''),CASE WHEN length(source.notes)>0 THEN 'Merged profile notes: '||source.notes END)
      FROM crm_people source WHERE target.person_id=${uuid(toId)} AND source.person_id=${uuid(fromId)};
    UPDATE crm_people SET merged_into=${uuid(toId)} WHERE person_id=${uuid(fromId)} OR merged_into=${uuid(fromId)};
    INSERT INTO crm_audit_log(action,entity_id,detail) VALUES ('merge_people',${q(fromId)},${json({into:toId,raw_import_rows_preserved:true,provenance})});`);
}

export async function associateGoogleAccount(ownerEmail,accountEmail,name){
  const owner=email(ownerEmail),account=email(accountEmail);
  const members=await getMembers();
  if(!members.some(m=>m.email===owner))throw new Error('Choose a founder');
  if(members.some(m=>m.email===account&&m.email!==owner))throw new Error('Connect this account under its own founder');
  await tx(`WITH person AS (INSERT INTO crm_people(name,relationship)
    SELECT (SELECT name FROM crm_members WHERE email=${q(owner)}),'founder'
    WHERE NOT EXISTS(SELECT 1 FROM crm_person_emails WHERE email=${q(owner)}) RETURNING person_id)
    INSERT INTO crm_person_emails(email,person_id,provenance) SELECT ${q(owner)},person_id,'Founder account' FROM person ON CONFLICT DO NOTHING;`);
  const identities=await queryRows(`SELECT email,person_id FROM crm_person_emails WHERE email IN (${q(owner)},${q(account)});`);
  const canonical=identities.find(p=>p.email===owner).person_id,previous=identities.find(p=>p.email===account)?.person_id;
  const provenance='Google verified the account email; its founder was selected during sign-in';
  if(previous&&previous!==canonical)await mergePeople(previous,canonical,provenance);
  await tx(`INSERT INTO crm_person_emails(email,person_id,provenance) VALUES (${q(account)},${uuid(canonical)},${q(provenance)}) ON CONFLICT DO NOTHING;
    UPDATE crm_people SET relationship='founder' WHERE person_id=${uuid(canonical)};`);
}

export async function enrichRecording(assetId,{summary,evidence,ownerEmail}={}){
  await executeSql(`UPDATE crm_touchpoints SET body=${q(summary||'')},raw=raw || ${json({sampled_transcript_evidence:evidence||[],transcript_status:'sampled-only'})},owner_id=${ownerEmail?`(SELECT member_id FROM crm_members WHERE email=${q(email(ownerEmail))})`:'owner_id'},updated_at=now() WHERE source='media-archive' AND external_id=${q(assetId)};`,{application:'portomatic_crm'});
}

export async function refreshTranscripts(){
  await executeSql(`UPDATE crm_touchpoints t SET body=s.text,raw=t.raw || jsonb_build_object('transcript_status',s.status),updated_at=now()
    FROM (SELECT tr.recording_id,string_agg(ts.transcript,E'\\n' ORDER BY tr.created_at,ts.sequence) AS text,
      CASE WHEN bool_and(tr.status='complete') THEN 'complete' ELSE 'partial' END AS status
      FROM transcript_runs tr JOIN transcript_segments ts USING(transcript_run_id) WHERE tr.is_current GROUP BY tr.recording_id) s
    WHERE t.source='customer-recording' AND t.external_id=s.recording_id::text AND NOT EXISTS(SELECT 1 FROM crm_transcripts tr WHERE tr.touchpoint_id=t.touchpoint_id AND tr.is_current) AND (t.body IS DISTINCT FROM s.text OR t.raw->>'transcript_status' IS DISTINCT FROM s.status);`,{application:'portomatic_crm'});
}

let matchingFingerprint=null;
export async function suggestLinks(){
  const rows=await queryRows(`SELECT jsonb_build_object(
    'recordings',(SELECT coalesce(jsonb_agg(x),'[]') FROM (
      SELECT r.touchpoint_id AS id,r.owner_id,r.occurred_at,r.ends_at,r.raw->>'source_filename' AS filename,
        coalesce(r.raw->'source_metadata','{}') AS metadata,
        coalesce((SELECT jsonb_agg(l.meeting_id) FROM crm_links l WHERE l.recording_id=r.touchpoint_id AND l.status='rejected'),'[]') AS rejected
      FROM crm_touchpoints r WHERE r.kind='recording' AND NOT EXISTS(SELECT 1 FROM crm_links l WHERE l.recording_id=r.touchpoint_id AND l.status='confirmed')) x),
    'meetings',(SELECT coalesce(jsonb_agg(x),'[]') FROM (
      SELECT m.touchpoint_id AS id,m.owner_id,m.external_id,m.source_account AS account,m.occurred_at,m.ends_at,
        (m.raw->>'status'='cancelled' OR coalesce(m.raw->>'source_status','')='Cancelled') IS TRUE AS cancelled,
        coalesce((m.raw->>'all_day')::boolean,false) AS all_day,
        jsonb_build_array(m.raw->>'hangoutLink',m.raw->>'hangout_link',m.raw->>'location',m.raw#>>'{conferenceData,entryPoints,0,uri}') AS urls
      FROM crm_touchpoints m WHERE m.kind='meeting' AND m.source='google-calendar') x)
  )::text AS data;`,{rowLimit:1});
  const data=parse(rows[0].data),fingerprint=crypto.createHash('sha256').update(rows[0].data).digest('hex');
  if(fingerprint===matchingFingerprint)return;
  const matches=data.recordings.map(r=>({recordingId:r.id,...automaticMeeting(r,data.meetings)})).filter(m=>m.meetingId);
  await tx(`UPDATE crm_links SET status='inactive',reason='Legacy review queue retired; calendar association is now automatic.' WHERE status='candidate';
    UPDATE crm_links SET status='inactive' WHERE status='automatic';
    DELETE FROM crm_touchpoint_people WHERE role='calendar-context';
    ${matches.map(m=>`INSERT INTO crm_links(recording_id,meeting_id,status,reason,evidence)
      VALUES (${uuid(m.recordingId)},${uuid(m.meetingId)},'automatic','Automatic calendar association',${json({method:'calendar-context-v1',score:m.score,reasons:m.evidence})})
      ON CONFLICT(recording_id,meeting_id) DO UPDATE SET status='automatic',reason=excluded.reason,evidence=excluded.evidence WHERE crm_links.status NOT IN ('confirmed','rejected');`).join('\n')}
    INSERT INTO crm_touchpoint_people(touchpoint_id,person_id,role)
      SELECT l.recording_id,p.person_id,'calendar-context' FROM crm_links l JOIN crm_touchpoint_people p ON p.touchpoint_id=l.meeting_id
      WHERE l.status='automatic' ON CONFLICT DO NOTHING;
  `);
  matchingFingerprint=fingerprint;
}

export async function assignOwner(id,ownerEmail,provenance='Manual attribution in CRM'){
  const owner=email(ownerEmail);
  await tx(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM crm_members WHERE email=${q(owner)}) THEN RAISE EXCEPTION 'Founder not found'; END IF; END $$;
    UPDATE crm_touchpoints SET owner_id=(SELECT member_id FROM crm_members WHERE email=${q(owner)}),raw=raw || ${json({owner_attribution:provenance})},updated_at=now() WHERE touchpoint_id=${uuid(id)};
    INSERT INTO crm_audit_log(action,entity_id,detail) VALUES ('assign_owner',${q(id)},${json({owner,provenance})});`);
}

export async function updatePerson(id,{name,company,relationship,notes,addEmail}){
  if(!['unknown','prospect','customer','partner','investor','vendor','founder','other'].includes(relationship))throw new Error('Invalid relationship');
  if(!name?.trim())throw new Error('Enter a name');
  await tx(`UPDATE crm_people SET name=${q(name.trim())},company=${q(company||null)},relationship=${q(relationship)},notes=${q(notes||'')} WHERE person_id=${uuid(id)};
    ${addEmail?`INSERT INTO crm_person_emails(email,person_id,provenance) VALUES (${q(email(addEmail))},${uuid(id)},'manual identity correction') ON CONFLICT(email) DO NOTHING;
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM crm_person_emails WHERE email=${q(email(addEmail))} AND person_id=${uuid(id)}) THEN RAISE EXCEPTION 'Email belongs to another person; merge the profiles explicitly instead'; END IF; END $$;`:''}
    INSERT INTO crm_audit_log(action,entity_id,detail) VALUES ('update_person',${q(id)},${json({name,company,relationship,addEmail:addEmail||null})});`);
}

export async function addNote(personId,body,ownerEmail){
  if(!body?.trim())throw new Error('Enter a note');
  const result=await queryRows(`INSERT INTO crm_touchpoints(kind,source,external_id,title,occurred_at,body,owner_id) VALUES ('note','manual',gen_random_uuid()::text,'Note',now(),${q(body.trim())},(SELECT member_id FROM crm_members WHERE email=${q(email(ownerEmail))})) RETURNING touchpoint_id;`);
  await executeSql(`INSERT INTO crm_touchpoint_people(touchpoint_id,person_id) VALUES (${uuid(result[0].touchpoint_id)},${uuid(personId)});`);
}

export async function recording(id){
  const rows=await queryRows(`SELECT * FROM crm_touchpoints WHERE touchpoint_id=${uuid(id)} AND kind='recording';`,{rowLimit:1});
  if(!rows[0])throw new Error('Recording not found');
  return {...rows[0],raw:parse(rows[0].raw)};
}
