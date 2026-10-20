BEGIN;
ALTER TABLE crm_links DROP CONSTRAINT IF EXISTS crm_links_status_check;
ALTER TABLE crm_links ADD CONSTRAINT crm_links_status_check CHECK(status IN ('candidate','confirmed','rejected','automatic','inactive'));
ALTER TABLE crm_links ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE crm_links SET status='inactive',reason='Legacy review queue retired; calendar association is now automatic.' WHERE status='candidate';
INSERT INTO schema_migrations(migration_name) VALUES ('014_crm_automatic_links.sql') ON CONFLICT DO NOTHING;
COMMIT;
