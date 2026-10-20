BEGIN;
ALTER TABLE crm_people ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES crm_people(person_id);
ALTER TABLE crm_people ADD CONSTRAINT crm_people_merge_not_self CHECK (merged_into IS NULL OR merged_into<>person_id);
CREATE INDEX IF NOT EXISTS crm_people_canonical_idx ON crm_people(merged_into);
INSERT INTO schema_migrations(migration_name) VALUES ('012_crm_identity_merges.sql') ON CONFLICT DO NOTHING;
COMMIT;
