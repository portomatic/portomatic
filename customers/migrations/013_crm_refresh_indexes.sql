BEGIN;
CREATE INDEX IF NOT EXISTS crm_touchpoints_kind_time_idx ON crm_touchpoints(kind,occurred_at DESC);
INSERT INTO schema_migrations(migration_name) VALUES ('013_crm_refresh_indexes.sql') ON CONFLICT DO NOTHING;
COMMIT;
