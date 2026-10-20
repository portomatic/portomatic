BEGIN;
ALTER TABLE crm_sources DROP CONSTRAINT IF EXISTS crm_sources_provider_check;
ALTER TABLE crm_sources ADD CONSTRAINT crm_sources_provider_check CHECK (provider IN ('gmail','calendar','drive','recordings','linkedin','imessage'));

CREATE TABLE IF NOT EXISTS crm_person_phones (
  phone text PRIMARY KEY CHECK (phone ~ '^\+[0-9]+$'),
  person_id uuid NOT NULL REFERENCES crm_people(person_id),
  provenance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_phones_person_idx ON crm_person_phones(person_id);

CREATE TABLE IF NOT EXISTS crm_imessage_contacts (
  owner_id uuid NOT NULL REFERENCES crm_members(member_id),
  contact_id text NOT NULL,
  person_id uuid NOT NULL REFERENCES crm_people(person_id),
  decision_basis text NOT NULL,
  outreach_suppressed boolean NOT NULL DEFAULT false,
  preferred_channel text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,contact_id)
);
CREATE INDEX IF NOT EXISTS crm_imessage_contacts_person_idx ON crm_imessage_contacts(person_id);
ALTER TABLE crm_imessage_contacts ADD COLUMN IF NOT EXISTS contact_fingerprint text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS crm_imessage_contact_messages_idx ON crm_touchpoints(source_account,(raw->>'imessage_contact_id')) WHERE source='imessage';
INSERT INTO schema_migrations(migration_name) VALUES ('020_crm_imessage.sql') ON CONFLICT DO NOTHING;
COMMIT;
