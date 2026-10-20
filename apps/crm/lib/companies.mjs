import crypto from 'node:crypto';
import {queryRows,executeSql,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';
import {uuid,json} from './store.mjs';

export const publishedTier='Published product evidence';
export const researchTiers=[publishedTier,'Early access','YC description only','Slackbot MCP only','Unconfirmed lead','Historical / pivoted','Coming soon'];
export const companyRelationships=['unknown','prospect','contacted','qualified','customer','partner','not_target'];
export function companyNameKey(value){return String(value||'').trim().toLowerCase().replace(/\s+(incorporated|inc|llc|ltd|limited|corporation|corp)\.?$/,'').replace(/[^a-z0-9]/g,'');}
const sharedDomains=new Set(['gmail.com','outlook.com','hotmail.com','yahoo.com','icloud.com','proton.me','protonmail.com','github.com','github.io','notion.so','notion.site','vercel.app','slack.com','ycombinator.com']);
export function companyDomain(value){
  try{const u=new URL(value),domain=u.hostname.toLowerCase().replace(/^www\./,'');return ['http:','https:'].includes(u.protocol)&&domain.includes('.')&&!sharedDomains.has(domain)?domain:null;}catch{return null;}
}
function webUrl(value){try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol))throw 0;return u.href;}catch{throw new Error('Research requires valid web source URLs');}}
export function validateResearch(data){
  if(!data?.metadata||!/^\d{4}-\d{2}-\d{2}$/.test(data.metadata.research_date)||!Number.isFinite(Date.parse(data.metadata.research_date)))throw new Error('Research requires a dated source snapshot');
  if(!Array.isArray(data.companies)||!data.companies.length||data.companies.length>10000)throw new Error('Research requires 1–10,000 company rows');
  const slugs=new Set();
  for(const row of data.companies){
    if(!/^[a-z0-9][a-z0-9-]*$/.test(row.yc_slug)||slugs.has(row.yc_slug))throw new Error('Research company identities must be unique YC slugs');
    slugs.add(row.yc_slug);
    if(!row.name?.trim()||!row.behavior?.trim()||!row.batch||!row.category||!row.product||!researchTiers.includes(row.evidence_tier))throw new Error('Company research requires name, batch, behavior, category, product, and evidence tier');
    for(const url of [row.website,row.yc_url,row.evidence_url,...(row.marketplace_urls||[])])webUrl(url);
    const yc=new URL(row.yc_url);
    if(!['www.ycombinator.com','ycombinator.com'].includes(yc.hostname)||yc.pathname.replace(/\/$/,'')!=='/companies/'+row.yc_slug)throw new Error('YC evidence must match the company identity');
  }
  return data;
}

export async function importCompanyResearch(data,{slug='yc-slack-bots',name='YC companies with Slack bots'}={}){
  validateResearch(data);
  if(!/^[a-z0-9][a-z0-9-]*$/.test(slug)||!String(name).trim())throw new Error('Choose a list name and slug');
  const hash=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'),date=data.metadata.research_date;
  const sql=[`INSERT INTO crm_company_lists(slug,name,description,metadata) VALUES(${q(slug)},${q(name)},${q(data.metadata.definition||'')},${json(data.metadata)}) ON CONFLICT(slug) DO UPDATE SET name=excluded.name,description=excluded.description,metadata=excluded.metadata,updated_at=now();`,
    `INSERT INTO crm_company_research_imports(list_id,sha256,research_date,raw) SELECT list_id,${q(hash)},${q(date)}::date,${json(data)} FROM crm_company_lists WHERE slug=${q(slug)} ON CONFLICT DO NOTHING;`];
  for(const r of data.companies){
    sql.push(`INSERT INTO crm_companies(yc_slug,name,website,yc_url,yc_batch,yc_status) VALUES(${q(r.yc_slug)},${q(r.name)},${q(r.website)},${q(r.yc_url)},${q(r.batch)},${q(r.yc_status||'Unknown')}) ON CONFLICT(yc_slug) DO UPDATE SET name=excluded.name,website=excluded.website,yc_url=excluded.yc_url,yc_batch=excluded.yc_batch,yc_status=excluded.yc_status,updated_at=now();`);
    // Product aliases are evidence-backed names, never fuzzy substring matches.
    for(const alias of new Set([r.name,...String(r.product).split(' / '),...(r.aliases||[])])){
      const key=companyNameKey(alias);if(!key)continue;
      sql.push(`INSERT INTO crm_company_aliases(company_id,alias,normalized_alias,provenance) SELECT company_id,${q(alias)},${q(key)},${q('research:'+slug+':'+date)} FROM crm_companies WHERE yc_slug=${q(r.yc_slug)} ON CONFLICT DO NOTHING;`);
    }
    const domain=companyDomain(r.website);
    if(domain)sql.push(`INSERT INTO crm_company_domains(company_id,domain,provenance) SELECT company_id,${q(domain)},${q(r.yc_url)} FROM crm_companies WHERE yc_slug=${q(r.yc_slug)} ON CONFLICT DO NOTHING;`);
    sql.push(`INSERT INTO crm_company_list_members(list_id,company_id,import_id,evidence_tier,category,product,behavior,evidence_url,checked_at,research)
      SELECT l.list_id,c.company_id,i.import_id,${q(r.evidence_tier)},${q(r.category)},${q(r.product)},${q(r.behavior)},${q(r.evidence_url)},${q(date)}::date,${json(r)}
      FROM crm_company_lists l JOIN crm_company_research_imports i USING(list_id) CROSS JOIN crm_companies c
      WHERE l.slug=${q(slug)} AND i.sha256=${q(hash)} AND c.yc_slug=${q(r.yc_slug)}
      ON CONFLICT(list_id,company_id) DO UPDATE SET import_id=excluded.import_id,evidence_tier=excluded.evidence_tier,category=excluded.category,product=excluded.product,behavior=excluded.behavior,evidence_url=excluded.evidence_url,checked_at=excluded.checked_at,research=excluded.research;`);
  }
  sql.push(`INSERT INTO crm_audit_log(action,entity_id,detail) VALUES('import_company_research',${q(slug)},${json({sha256:hash,rows:data.companies.length,research_date:date})});`);
  await executeSql('BEGIN; SELECT pg_advisory_xact_lock(519201002);'+sql.join('\n')+'COMMIT;',{application:'portomatic_crm_companies'});
  const check=await queryRows(`SELECT count(*) AS companies,count(*) FILTER(WHERE m.evidence_tier=${q(publishedTier)}) AS published FROM crm_company_list_members m JOIN crm_company_lists l USING(list_id) WHERE l.slug=${q(slug)} AND m.import_id=(SELECT i.import_id FROM crm_company_research_imports i WHERE i.list_id=l.list_id AND i.sha256=${q(hash)});`);
  if(Number(check[0].companies)!==data.companies.length)throw new Error('Research import verification failed');
  return {slug,sha256:hash,imported:Number(check[0].companies),published:Number(check[0].published)};
}

export async function companiesState({search='',company='',list='yc-slack-bots',evidence=publishedTier,category='',owner=''}={}){
  if(evidence!=='all'&&!researchTiers.includes(evidence))throw new Error('Invalid evidence filter');
  const where=[`l.slug=${q(list)}`];
  if(evidence!=='all')where.push(`lm.evidence_tier=${q(evidence)}`);
  if(category)where.push(`lm.category=${q(category)}`);
  if(search)where.push(`(c.name ILIKE ${q('%'+search+'%')} OR c.yc_batch ILIKE ${q('%'+search+'%')} OR lm.product ILIKE ${q('%'+search+'%')} OR lm.behavior ILIKE ${q('%'+search+'%')})`);
  if(owner)where.push(`EXISTS(SELECT 1 FROM crm_company_person_matches cm JOIN crm_touchpoint_people tp USING(person_id) JOIN crm_touchpoints t USING(touchpoint_id) WHERE cm.company_id=c.company_id AND t.owner_id=${uuid(owner)})`);
  const detail=company?uuid(company):'NULL::uuid';
  const result=await queryRows(`WITH listed AS MATERIALIZED (
      SELECT c.*,lm.evidence_tier,lm.category,lm.product,lm.behavior,lm.evidence_url,lm.checked_at,lm.research,l.name AS list_name,l.slug AS list_slug
      FROM crm_companies c JOIN crm_company_list_members lm USING(company_id) JOIN crm_company_lists l USING(list_id)
      WHERE ${where.join(' AND ')}
    ), scoped AS MATERIALIZED (
      SELECT * FROM listed UNION ALL SELECT c.*,lm.evidence_tier,lm.category,lm.product,lm.behavior,lm.evidence_url,lm.checked_at,lm.research,l.name,l.slug
      FROM crm_companies c JOIN crm_company_list_members lm USING(company_id) JOIN crm_company_lists l USING(list_id)
      WHERE c.company_id=${detail} AND l.slug=${q(list)} AND NOT EXISTS(SELECT 1 FROM listed WHERE company_id=${detail})
    ), matches AS MATERIALIZED (
      SELECT cm.* FROM crm_company_person_matches cm JOIN scoped USING(company_id)
      WHERE ${owner?`EXISTS(SELECT 1 FROM crm_touchpoint_people tp JOIN crm_touchpoints t USING(touchpoint_id) WHERE tp.person_id=cm.person_id AND t.owner_id=${uuid(owner)})`:'true'}
    ), activity AS MATERIALIZED (
      SELECT cm.company_id,cm.person_id,t.touchpoint_id,t.kind,t.owner_id,t.occurred_at,m.name AS owner_name
      FROM matches cm JOIN crm_touchpoint_people tp USING(person_id) JOIN crm_touchpoints t USING(touchpoint_id)
      LEFT JOIN crm_members m ON m.member_id=t.owner_id WHERE ${owner?`t.owner_id=${uuid(owner)}`:'true'}
    ), summary AS (
      SELECT cm.company_id,count(DISTINCT cm.person_id) AS people_count,
        count(DISTINCT cm.person_id) FILTER(WHERE cm.status='confirmed') AS confirmed_people,
        count(DISTINCT a.person_id) FILTER(WHERE a.kind='connection') AS linkedin_connections,
        max(a.occurred_at) FILTER(WHERE a.kind NOT IN ('connection','document') AND a.occurred_at<=now()) AS last_touch,
        coalesce(jsonb_agg(DISTINCT a.owner_name) FILTER(WHERE a.owner_name IS NOT NULL),'[]') AS founders
      FROM matches cm LEFT JOIN activity a USING(company_id,person_id) GROUP BY cm.company_id
    ) SELECT jsonb_build_object(
      'members',(SELECT coalesce(jsonb_agg(m ORDER BY name),'[]') FROM (SELECT member_id,email,name FROM crm_members) m),
      'counts',jsonb_build_object('people',(SELECT count(*) FROM crm_people WHERE merged_into IS NULL AND relationship<>'founder'),'touchpoints',(SELECT count(*) FROM crm_touchpoints),'recordings',(SELECT count(*) FROM crm_touchpoints WHERE kind='recording'),'companies',(SELECT count(*) FROM crm_companies)),
      'lists',(SELECT coalesce(jsonb_agg(x ORDER BY name),'[]') FROM (SELECT l.*,count(lm.company_id) AS companies,count(lm.company_id) FILTER(WHERE lm.evidence_tier=${q(publishedTier)}) AS published FROM crm_company_lists l LEFT JOIN crm_company_list_members lm USING(list_id) GROUP BY l.list_id) x),
      'categories',(SELECT coalesce(jsonb_agg(category ORDER BY category),'[]') FROM (SELECT DISTINCT category FROM crm_company_list_members JOIN crm_company_lists USING(list_id) WHERE slug=${q(list)}) x),
      'companies',(SELECT coalesce(jsonb_agg(x ORDER BY x.last_touch DESC NULLS LAST,x.name),'[]') FROM (SELECT l.*,coalesce(s.people_count,0) AS people_count,coalesce(s.confirmed_people,0) AS confirmed_people,coalesce(s.linkedin_connections,0) AS linkedin_connections,s.last_touch,coalesce(s.founders,'[]') AS founders FROM listed l LEFT JOIN summary s USING(company_id)) x),
      'company',(SELECT to_jsonb(s) FROM scoped s WHERE company_id=${detail} LIMIT 1),
      'company_people',(SELECT coalesce(jsonb_agg(x ORDER BY x.last_touch DESC NULLS LAST,x.name),'[]') FROM (
        SELECT p.person_id,p.name,p.company,p.position,cm.status AS company_match,cm.reasons,cm.reviewed_by,
          coalesce((SELECT jsonb_agg(email ORDER BY email) FROM crm_person_emails e WHERE e.person_id=p.person_id),'[]') AS emails,
          coalesce((SELECT jsonb_agg(jsonb_build_object('platform',platform,'url',profile_url)) FROM crm_person_profiles pr WHERE pr.person_id=p.person_id),'[]') AS profiles,
          (SELECT max(occurred_at) FROM activity a WHERE a.company_id=cm.company_id AND a.person_id=p.person_id AND a.kind NOT IN ('connection','document') AND a.occurred_at<=now()) AS last_touch,
          (SELECT coalesce(jsonb_agg(DISTINCT a.owner_name) FILTER(WHERE a.owner_name IS NOT NULL),'[]') FROM activity a WHERE a.company_id=cm.company_id AND a.person_id=p.person_id AND a.kind='connection') AS linkedin_founders,
          (SELECT coalesce(jsonb_agg(DISTINCT a.owner_name) FILTER(WHERE a.owner_name IS NOT NULL),'[]') FROM activity a WHERE a.company_id=cm.company_id AND a.person_id=p.person_id) AS founders
        FROM matches cm JOIN crm_people p USING(person_id) WHERE cm.company_id=${detail}
      ) x),
      'timeline',(SELECT coalesce(jsonb_agg(x ORDER BY occurred_at DESC),'[]') FROM (
        SELECT t.touchpoint_id,t.kind,t.source,t.title,t.body,t.occurred_at,t.source_url,t.storage_uri,t.classification,t.owner_name,t.people,
          t.raw->>'transcript_status' AS transcript_status,t.raw->>'bytes' AS bytes,t.raw->>'duration_ms' AS duration_ms,
          (SELECT j.status FROM crm_transcription_jobs j WHERE j.touchpoint_id=t.touchpoint_id ORDER BY j.created_at DESC LIMIT 1) AS transcription_job_status,
          (SELECT l.recording_id FROM crm_links l WHERE l.meeting_id=t.touchpoint_id AND l.status IN ('confirmed','automatic') ORDER BY (l.status='confirmed') DESC,l.created_at LIMIT 1) AS recording_link
        FROM crm_timeline t WHERE EXISTS(SELECT 1 FROM activity a WHERE a.company_id=${detail} AND a.touchpoint_id=t.touchpoint_id)
        ORDER BY t.occurred_at DESC LIMIT 150
      ) x)
    )::text AS data;`,{rowLimit:1});
  return JSON.parse(result[0].data);
}

export async function updateCompany(id,{relationship='unknown',nextStep='',notes='',ownerId=''},reviewedBy){
  if(!companyRelationships.includes(relationship))throw new Error('Invalid company relationship');
  if(String(nextStep).length>5000||String(notes).length>50000)throw new Error('Company notes are too long');
  const updated=await queryRows(`WITH saved AS (UPDATE crm_companies SET relationship=${q(relationship)},next_step=${q(nextStep)},notes=${q(notes)},owner_id=${ownerId?uuid(ownerId):'NULL'},updated_at=now() WHERE company_id=${uuid(id)} RETURNING company_id),logged AS (INSERT INTO crm_audit_log(action,entity_id,detail) SELECT 'update_company',company_id::text,${json({relationship,nextStep,notes,ownerId,reviewedBy})} FROM saved) SELECT company_id FROM saved;`);
  if(!updated.length)throw new Error('Company not found');
  return {saved:true};
}
export async function linkCompanyPerson({companyId,personId,status},reviewedBy){
  if(!['confirmed','rejected'].includes(status))throw new Error('Invalid company match decision');
  const result=await queryRows(`WITH saved AS (
    INSERT INTO crm_company_person_links(company_id,person_id,status,reviewed_by)
    SELECT c.company_id,p.person_id,${q(status)},${q(reviewedBy)} FROM crm_companies c CROSS JOIN crm_people p
    WHERE c.company_id=${uuid(companyId)} AND p.person_id=${uuid(personId)} AND p.merged_into IS NULL AND p.relationship<>'founder'
    ON CONFLICT(company_id,person_id) DO UPDATE SET status=excluded.status,reviewed_by=excluded.reviewed_by,updated_at=now() RETURNING company_id,person_id
  ), logged AS (INSERT INTO crm_audit_log(action,entity_id,detail) SELECT 'company_person_link',company_id::text,${json({personId,status,reviewedBy})} FROM saved) SELECT person_id FROM saved;`);
  if(!result.length)throw new Error('Company or person not found');
  return {saved:true};
}
