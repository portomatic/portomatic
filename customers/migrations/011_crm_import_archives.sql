BEGIN;
ALTER TABLE crm_people ADD COLUMN IF NOT EXISTS position text;
CREATE TABLE IF NOT EXISTS crm_person_profiles (
  platform text NOT NULL,
  profile_url text NOT NULL,
  person_id uuid NOT NULL REFERENCES crm_people(person_id),
  provenance text NOT NULL,
  PRIMARY KEY(platform,profile_url)
);
CREATE INDEX IF NOT EXISTS crm_profiles_person_idx ON crm_person_profiles(person_id);
CREATE TABLE IF NOT EXISTS crm_import_archives (
  archive_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES crm_members(member_id),
  provider text NOT NULL,
  source_filename text NOT NULL,
  exported_at timestamptz,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  md5_base64 text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes>0),
  storage_uri text NOT NULL,
  object_generation bigint NOT NULL,
  manifest_uri text NOT NULL,
  manifest_sha256 text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(owner_id,provider,sha256)
);
CREATE TABLE IF NOT EXISTS crm_import_rows (
  archive_id uuid NOT NULL REFERENCES crm_import_archives(archive_id),
  source_file text NOT NULL,
  row_number integer NOT NULL,
  raw jsonb NOT NULL,
  person_id uuid REFERENCES crm_people(person_id),
  PRIMARY KEY(archive_id,source_file,row_number)
);
ALTER TABLE crm_sources DROP CONSTRAINT IF EXISTS crm_sources_provider_check;
ALTER TABLE crm_sources ADD CONSTRAINT crm_sources_provider_check CHECK (provider IN ('gmail','calendar','drive','recordings','linkedin'));
ALTER TABLE crm_touchpoints DROP CONSTRAINT IF EXISTS crm_touchpoints_kind_check;
ALTER TABLE crm_touchpoints ADD CONSTRAINT crm_touchpoints_kind_check CHECK (kind IN ('email','meeting','recording','document','note','connection','message'));
DROP TRIGGER IF EXISTS crm_import_archives_are_immutable ON crm_import_archives;
CREATE TRIGGER crm_import_archives_are_immutable BEFORE UPDATE OR DELETE ON crm_import_archives FOR EACH ROW EXECUTE FUNCTION reject_media_archive_asset_mutation();
DROP TRIGGER IF EXISTS crm_import_rows_are_immutable ON crm_import_rows;
CREATE TRIGGER crm_import_rows_are_immutable BEFORE UPDATE OR DELETE ON crm_import_rows FOR EACH ROW EXECUTE FUNCTION reject_media_archive_asset_mutation();
INSERT INTO schema_migrations(migration_name) VALUES ('011_crm_import_archives.sql') ON CONFLICT DO NOTHING;
COMMIT;
