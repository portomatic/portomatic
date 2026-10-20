BEGIN;

CREATE TABLE IF NOT EXISTS crm_members (
  member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_people (
  person_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  company text,
  relationship text NOT NULL DEFAULT 'unknown' CHECK (relationship IN ('unknown','prospect','customer','partner','investor','vendor','founder','other')),
  legacy_customer_id uuid UNIQUE REFERENCES customers(customer_id),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_person_emails (
  email text PRIMARY KEY CHECK (email = lower(email) AND position('@' in email) > 1),
  person_id uuid NOT NULL REFERENCES crm_people(person_id),
  provenance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_touchpoints (
  touchpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('email','meeting','recording','document','note')),
  source text NOT NULL,
  source_account text NOT NULL DEFAULT '',
  external_id text NOT NULL,
  owner_id uuid REFERENCES crm_members(member_id),
  title text NOT NULL,
  occurred_at timestamptz NOT NULL,
  ends_at timestamptz,
  body text NOT NULL DEFAULT '',
  source_url text,
  storage_uri text,
  classification text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source,source_account,external_id)
);

CREATE TABLE IF NOT EXISTS crm_touchpoint_people (
  touchpoint_id uuid NOT NULL REFERENCES crm_touchpoints(touchpoint_id),
  person_id uuid NOT NULL REFERENCES crm_people(person_id),
  role text NOT NULL DEFAULT 'participant',
  PRIMARY KEY(touchpoint_id,person_id)
);

CREATE TABLE IF NOT EXISTS crm_links (
  link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid NOT NULL REFERENCES crm_touchpoints(touchpoint_id),
  meeting_id uuid NOT NULL REFERENCES crm_touchpoints(touchpoint_id),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','rejected')),
  reason text NOT NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(recording_id <> meeting_id),
  UNIQUE(recording_id,meeting_id)
);

CREATE TABLE IF NOT EXISTS crm_sources (
  source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES crm_members(member_id),
  provider text NOT NULL CHECK (provider IN ('gmail','calendar','drive','recordings')),
  account text NOT NULL,
  status text NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected','ready','syncing','connected','error')),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  error text,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(owner_id,provider,account)
);

CREATE TABLE IF NOT EXISTS crm_audit_log (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_touchpoints_time_idx ON crm_touchpoints(occurred_at DESC);
CREATE INDEX IF NOT EXISTS crm_touchpoints_search_idx ON crm_touchpoints USING gin(search_document);
CREATE INDEX IF NOT EXISTS crm_people_name_idx ON crm_people(lower(name));
CREATE INDEX IF NOT EXISTS crm_touchpoint_people_person_idx ON crm_touchpoint_people(person_id);

INSERT INTO crm_people(person_id,name,company,legacy_customer_id)
SELECT customer_id,name,company,customer_id FROM customers
ON CONFLICT (legacy_customer_id) DO NOTHING;

INSERT INTO crm_touchpoints(kind,source,external_id,title,occurred_at,body,classification,raw)
SELECT 'meeting','customer-call',c.call_id,c.title,c.recorded_at,coalesce(c.notes,''),'historical conversation',jsonb_build_object('call_id',c.call_id,'provenance','Existing customer-call catalog; customer relationship is not implied.')
FROM active_calls c
ON CONFLICT(source,source_account,external_id) DO NOTHING;

INSERT INTO crm_touchpoint_people(touchpoint_id,person_id)
SELECT t.touchpoint_id,p.person_id FROM crm_touchpoints t
JOIN calls c ON t.source='customer-call' AND t.external_id=c.call_id
JOIN crm_people p ON p.legacy_customer_id=c.primary_customer_id
ON CONFLICT DO NOTHING;

INSERT INTO crm_touchpoints(kind,source,external_id,title,occurred_at,ends_at,storage_uri,classification,raw)
SELECT 'recording','customer-recording',ro.recording_id::text,coalesce(ro.source_title,ro.source_filename),ro.recorded_at,
  ro.recorded_at + (ro.duration_ms * interval '1 millisecond'),ro.storage_uri,'historical recording',
  jsonb_build_object('recording_id',ro.recording_id,'sha256',ro.sha256,'bytes',ro.bytes,'duration_ms',ro.duration_ms,'object_generation',ro.object_generation,'source_filename',ro.source_filename)
FROM recording_objects ro
ON CONFLICT(source,source_account,external_id) DO NOTHING;

INSERT INTO crm_touchpoint_people(touchpoint_id,person_id)
SELECT DISTINCT t.touchpoint_id,p.person_id FROM crm_touchpoints t
JOIN call_recordings cr ON t.source='customer-recording' AND t.external_id=cr.recording_id::text
JOIN calls c USING(call_id)
JOIN crm_people p ON p.legacy_customer_id=c.primary_customer_id
ON CONFLICT DO NOTHING;

INSERT INTO crm_links(recording_id,meeting_id,status,reason,reviewed_at)
SELECT DISTINCT r.touchpoint_id,m.touchpoint_id,'confirmed','Existing call_recordings foreign-key relationship',now()
FROM call_recordings cr
JOIN crm_touchpoints r ON r.source='customer-recording' AND r.external_id=cr.recording_id::text
JOIN crm_touchpoints m ON m.source='customer-call' AND m.external_id=cr.call_id
ON CONFLICT DO NOTHING;

CREATE OR REPLACE VIEW crm_timeline AS
SELECT t.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.person_id,'name',p.name,'company',p.company,'relationship',p.relationship)) FROM crm_touchpoint_people tp JOIN crm_people p USING(person_id) WHERE tp.touchpoint_id=t.touchpoint_id),'[]'::jsonb) AS people,
  m.name AS owner_name,m.email AS owner_email
FROM crm_touchpoints t LEFT JOIN crm_members m ON m.member_id=t.owner_id;

INSERT INTO schema_migrations(migration_name) VALUES ('010_shared_crm.sql') ON CONFLICT DO NOTHING;
COMMIT;
