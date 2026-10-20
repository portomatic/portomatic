BEGIN;
-- Historical call catalogs sometimes represent a company as the named contact.
-- Keep this source-backed association possible until explicitly confirmed.
CREATE OR REPLACE VIEW crm_company_person_matches AS
WITH alias_targets AS (
  SELECT normalized_alias,min(company_id::text)::uuid AS company_id FROM crm_company_aliases
  GROUP BY normalized_alias HAVING count(DISTINCT company_id)=1
), domain_targets AS (
  SELECT domain,min(company_id::text)::uuid AS company_id FROM crm_company_domains
  GROUP BY domain HAVING count(DISTINCT company_id)=1
), candidates AS (
  SELECT a.company_id,p.person_id,'Company name: '||p.company AS reason FROM crm_people p
  JOIN alias_targets a ON a.normalized_alias=crm_company_name_key(p.company)
  WHERE p.merged_into IS NULL AND p.relationship<>'founder'
  UNION ALL
  SELECT a.company_id,p.person_id,'Historical account name: '||p.name FROM crm_people p
  JOIN alias_targets a ON a.normalized_alias=crm_company_name_key(p.name)
  WHERE p.legacy_customer_id IS NOT NULL AND p.merged_into IS NULL AND p.relationship<>'founder'
  UNION ALL
  SELECT d.company_id,p.person_id,'Email domain: '||d.domain FROM crm_person_emails e
  JOIN crm_people p USING(person_id) JOIN domain_targets d ON d.domain=lower(split_part(e.email,'@',2))
  WHERE p.merged_into IS NULL AND p.relationship<>'founder'
), grouped AS (
  SELECT company_id,person_id,jsonb_agg(DISTINCT reason) AS reasons FROM candidates GROUP BY company_id,person_id
), manual AS (
  SELECT DISTINCT ON(l.company_id,coalesce(p.merged_into,p.person_id)) l.company_id,
    coalesce(p.merged_into,p.person_id) AS person_id,l.status,l.reviewed_by,l.updated_at
  FROM crm_company_person_links l JOIN crm_people p USING(person_id)
  ORDER BY l.company_id,coalesce(p.merged_into,p.person_id),l.updated_at DESC
)
SELECT coalesce(g.company_id,m.company_id) AS company_id,coalesce(g.person_id,m.person_id) AS person_id,
  coalesce(m.status,'possible') AS status,coalesce(g.reasons,'[]'::jsonb) AS reasons,m.reviewed_by,m.updated_at AS reviewed_at
FROM grouped g FULL JOIN manual m USING(company_id,person_id)
JOIN crm_people p ON p.person_id=coalesce(g.person_id,m.person_id)
WHERE coalesce(m.status,'possible')<>'rejected' AND p.relationship<>'founder' AND p.merged_into IS NULL;

INSERT INTO schema_migrations(migration_name) VALUES('017_crm_company_account_matches.sql');
COMMIT;
