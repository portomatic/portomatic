BEGIN;

CREATE OR REPLACE VIEW media_archive_catalog AS
SELECT
  asset_id,
  source_filename,
  captured_at,
  classification,
  source_kind,
  parent_asset_id,
  duration_ms,
  bytes,
  storage_uri,
  object_generation,
  sha256,
  md5_base64,
  content_type,
  manifest_uri,
  manifest_generation,
  archived_at,
  manifest_sha256
FROM media_archive_assets;

INSERT INTO schema_migrations(migration_name)
VALUES ('009_media_archive_manifest_hash.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
