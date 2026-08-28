BEGIN;

ALTER TABLE recording_objects
  ADD COLUMN IF NOT EXISTS recorded_local_date date;

ALTER TABLE recording_objects DISABLE TRIGGER recording_objects_are_immutable;
UPDATE recording_objects
SET recorded_local_date = (recorded_at AT TIME ZONE 'America/Los_Angeles')::date
WHERE source_id IS NOT NULL AND recorded_local_date IS NULL;
ALTER TABLE recording_objects ENABLE TRIGGER recording_objects_are_immutable;

ALTER TABLE recording_objects
  DROP CONSTRAINT IF EXISTS recording_objects_source_metadata_complete,
  ADD CONSTRAINT recording_objects_source_metadata_complete CHECK (
    source_id IS NULL OR (
      source_title IS NOT NULL AND
      source_type IS NOT NULL AND
      recorded_at_precision IS NOT NULL AND
      recorded_local_date IS NOT NULL AND
      normalized_audio_sha256 IS NOT NULL AND
      source_manifest_uri IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS recording_objects_normalized_audio_unique
  ON recording_objects(normalized_audio_sha256) WHERE normalized_audio_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS recording_source_manifests (
  manifest_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid NOT NULL REFERENCES recording_objects(recording_id) ON DELETE RESTRICT,
  storage_uri text NOT NULL CHECK (storage_uri ~ '^gs://[a-z0-9][a-z0-9._-]+/.+'),
  object_generation bigint NOT NULL CHECK (object_generation > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_uri, object_generation),
  UNIQUE (recording_id, sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS recording_source_manifests_one_current
  ON recording_source_manifests(recording_id) WHERE is_current;

ALTER TABLE recording_segments
  DROP CONSTRAINT IF EXISTS recording_segments_parent_segment_id_fkey,
  ADD CONSTRAINT recording_segments_parent_identity_unique UNIQUE (recording_id, call_id, segment_id),
  ADD CONSTRAINT recording_segments_parent_same_source_call
    FOREIGN KEY (recording_id, call_id, parent_segment_id)
    REFERENCES recording_segments(recording_id, call_id, segment_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION validate_recording_segment_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_start bigint;
  parent_end bigint;
  recording_end bigint;
BEGIN
  SELECT duration_ms INTO recording_end
  FROM recording_objects WHERE recording_id = NEW.recording_id;
  IF recording_end IS NULL OR NEW.end_ms > recording_end THEN
    RAISE EXCEPTION 'segment must be contained within its recording';
  END IF;
  IF NEW.parent_segment_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM recording_segments child
      WHERE child.recording_id = NEW.recording_id
        AND child.call_id = NEW.call_id
        AND child.parent_segment_id = NEW.segment_id
        AND (child.start_ms < NEW.start_ms OR child.end_ms > NEW.end_ms)
    ) THEN
      RAISE EXCEPTION 'parent segment must contain all of its children';
    END IF;
    RETURN NEW;
  END IF;
  SELECT start_ms, end_ms INTO parent_start, parent_end
  FROM recording_segments
  WHERE recording_id = NEW.recording_id
    AND call_id = NEW.call_id
    AND segment_id = NEW.parent_segment_id;
  IF parent_start IS NULL OR NEW.start_ms < parent_start OR NEW.end_ms > parent_end THEN
    RAISE EXCEPTION 'child segment must be contained within its parent on the same recording and call';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recording_segment_parent_is_valid ON recording_segments;
CREATE TRIGGER recording_segment_parent_is_valid
BEFORE INSERT OR UPDATE ON recording_segments
FOR EACH ROW EXECUTE FUNCTION validate_recording_segment_parent();

DROP VIEW IF EXISTS conversation_catalog;
CREATE VIEW conversation_catalog AS
SELECT
  rs.segment_id,
  rs.call_id,
  c.title,
  cu.slug AS customer_slug,
  cu.name AS customer_name,
  cu.company,
  ro.source_id,
  ro.source_title,
  ro.source_type,
  ro.storage_uri AS recording_uri,
  ro.object_generation,
  ro.sha256,
  ro.normalized_audio_sha256,
  ro.recorded_at,
  ro.recorded_local_date,
  ro.recorded_at_precision,
  ro.duration_ms AS recording_duration_ms,
  rs.start_ms,
  rs.end_ms,
  rs.segment_kind,
  rs.interaction_type,
  rs.portomatic_relevance,
  rs.identity_confidence,
  rs.review_status,
  rs.evidence,
  rs.notes
FROM recording_segments rs
JOIN recording_objects ro USING (recording_id)
JOIN calls c USING (call_id)
JOIN customers cu ON cu.customer_id = c.primary_customer_id
WHERE rs.segment_kind IN ('conversation', 'customer_discovery', 'strategic_validation');

INSERT INTO schema_migrations(migration_name)
VALUES ('003_source_integrity.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
