BEGIN;

CREATE TABLE crm_companies (
  company_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  yc_slug text UNIQUE NOT NULL,
  name text NOT NULL CHECK(length(trim(name))>0),
  website text NOT NULL,
  yc_url text NOT NULL,
  yc_batch text NOT NULL,
  yc_status text NOT NULL,
  relationship text NOT NULL DEFAULT 'unknown' CHECK(relationship IN ('unknown','prospect','contacted','qualified','customer','partner','not_target')),
  next_step text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  owner_id uuid REFERENCES crm_members(member_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_company_aliases (
  company_id uuid NOT NULL REFERENCES crm_companies(company_id),
  alias text NOT NULL,
  normalized_alias text NOT NULL CHECK(length(normalized_alias)>0),
  provenance text NOT NULL,
  PRIMARY KEY(company_id,normalized_alias)
);
CREATE TABLE crm_company_domains (
  company_id uuid NOT NULL REFERENCES crm_companies(company_id),
  domain text NOT NULL,
  provenance text NOT NULL,
  PRIMARY KEY(company_id,domain)
);
CREATE INDEX crm_company_alias_lookup ON crm_company_aliases(normalized_alias);
CREATE INDEX crm_company_domain_lookup ON crm_company_domains(domain);
CREATE TABLE crm_company_lists (
  list_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_company_research_imports (
  import_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES crm_company_lists(list_id),
  sha256 text NOT NULL,
  research_date date NOT NULL,
  raw jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(list_id,sha256)
);
CREATE TABLE crm_company_list_members (
  list_id uuid NOT NULL REFERENCES crm_company_lists(list_id),
  company_id uuid NOT NULL REFERENCES crm_companies(company_id),
  import_id uuid NOT NULL REFERENCES crm_company_research_imports(import_id),
  evidence_tier text NOT NULL,
  category text NOT NULL,
  product text NOT NULL,
  behavior text NOT NULL,
  evidence_url text NOT NULL,
  checked_at date NOT NULL,
  research jsonb NOT NULL,
  PRIMARY KEY(list_id,company_id)
);
CREATE INDEX crm_company_members_company ON crm_company_list_members(company_id);
CREATE TABLE crm_company_person_links (
  company_id uuid NOT NULL REFERENCES crm_companies(company_id),
  person_id uuid NOT NULL REFERENCES crm_people(person_id),
  status text NOT NULL CHECK(status IN ('confirmed','rejected')),
  reviewed_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,person_id)
);

CREATE FUNCTION crm_company_name_key(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(regexp_replace(lower(trim(coalesce(value,''))), '\s+(incorporated|inc|llc|ltd|limited|corporation|corp)\.?$', ''), '[^a-z0-9]', '', 'g');
$$;
CREATE INDEX crm_people_company_key ON crm_people(crm_company_name_key(company)) WHERE merged_into IS NULL;

-- These are candidate associations only. No person identity or employment history is rewritten.
-- Ambiguous aliases/domains cannot generate automatic matches. Manual decisions take precedence.
CREATE VIEW crm_company_person_matches AS
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

INSERT INTO schema_migrations(migration_name) VALUES('016_crm_companies.sql');
COMMIT;
