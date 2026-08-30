BEGIN;

CREATE TABLE IF NOT EXISTS media_archive_assets (
  asset_id uuid PRIMARY KEY,
  storage_uri text NOT NULL CHECK (storage_uri ~ '^gs://[a-z0-9][a-z0-9._-]+/.+'),
  object_generation bigint NOT NULL CHECK (object_generation > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  md5_base64 text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms > 0),
  content_type text NOT NULL,
  source_filename text NOT NULL,
  captured_at timestamptz NOT NULL,
  captured_at_precision text NOT NULL CHECK (captured_at_precision IN ('second', 'filesystem')),
  classification text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('original', 'derived')),
  parent_asset_id uuid REFERENCES media_archive_assets(asset_id) ON DELETE RESTRICT,
  manifest_uri text NOT NULL CHECK (manifest_uri ~ '^gs://[a-z0-9][a-z0-9._-]+/.+'),
  manifest_generation bigint NOT NULL CHECK (manifest_generation > 0),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  archived_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind = 'original' AND parent_asset_id IS NULL) OR
         (source_kind = 'derived' AND parent_asset_id IS NOT NULL)),
  UNIQUE (storage_uri, object_generation),
  UNIQUE (manifest_uri, manifest_generation),
  UNIQUE (sha256, source_filename)
);

CREATE INDEX IF NOT EXISTS media_archive_assets_captured_at_idx
  ON media_archive_assets(captured_at DESC);
CREATE INDEX IF NOT EXISTS media_archive_assets_sha256_idx
  ON media_archive_assets(sha256);

CREATE OR REPLACE FUNCTION reject_media_archive_asset_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media archive assets are immutable; insert a correction or annotation instead';
END;
$$;

DROP TRIGGER IF EXISTS media_archive_assets_are_immutable ON media_archive_assets;
CREATE TRIGGER media_archive_assets_are_immutable
BEFORE UPDATE OR DELETE ON media_archive_assets
FOR EACH ROW EXECUTE FUNCTION reject_media_archive_asset_mutation();

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
VALUES ('008_media_archive.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
