BEGIN;

ALTER TABLE recording_objects
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS source_title text,
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS recorded_at_precision text,
  ADD COLUMN IF NOT EXISTS normalized_audio_sha256 text,
  ADD COLUMN IF NOT EXISTS source_manifest_uri text;

ALTER TABLE recording_objects
  DROP CONSTRAINT IF EXISTS recording_objects_source_id_format,
  ADD CONSTRAINT recording_objects_source_id_format
    CHECK (source_id IS NULL OR source_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  DROP CONSTRAINT IF EXISTS recording_objects_recorded_at_precision,
  ADD CONSTRAINT recording_objects_recorded_at_precision
    CHECK (recorded_at_precision IS NULL OR recorded_at_precision IN ('second', 'minute', 'calendar', 'day')),
  DROP CONSTRAINT IF EXISTS recording_objects_normalized_audio_sha256,
  ADD CONSTRAINT recording_objects_normalized_audio_sha256
    CHECK (normalized_audio_sha256 IS NULL OR normalized_audio_sha256 ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS recording_objects_source_manifest_uri,
  ADD CONSTRAINT recording_objects_source_manifest_uri
    CHECK (source_manifest_uri IS NULL OR source_manifest_uri ~ '^gs://[a-z0-9][a-z0-9._-]+/.+'),
  DROP CONSTRAINT IF EXISTS recording_objects_source_metadata_complete,
  ADD CONSTRAINT recording_objects_source_metadata_complete CHECK (
    source_id IS NULL OR (
      source_title IS NOT NULL AND
      source_type IS NOT NULL AND
      recorded_at_precision IS NOT NULL AND
      normalized_audio_sha256 IS NOT NULL AND
      source_manifest_uri IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS recording_objects_source_id_unique
  ON recording_objects(source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recording_objects_source_manifest_uri_unique
  ON recording_objects(source_manifest_uri) WHERE source_manifest_uri IS NOT NULL;

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_manifest_uri_key;

CREATE TABLE IF NOT EXISTS recording_segments (
  segment_id text PRIMARY KEY CHECK (segment_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  recording_id uuid NOT NULL REFERENCES recording_objects(recording_id) ON DELETE RESTRICT,
  call_id text REFERENCES calls(call_id) ON DELETE RESTRICT,
  parent_segment_id text REFERENCES recording_segments(segment_id) ON DELETE RESTRICT,
  start_ms bigint NOT NULL CHECK (start_ms >= 0),
  end_ms bigint NOT NULL CHECK (end_ms > start_ms),
  segment_kind text NOT NULL CHECK (segment_kind IN (
    'conversation', 'customer_discovery', 'portomatic_pitch', 'product_feedback',
    'strategic_validation', 'public_event', 'other'
  )),
  interaction_type text NOT NULL CHECK (interaction_type IN (
    'customer_discovery', 'prospect_conversation', 'strategic_conversation',
    'public_event', 'other'
  )),
  portomatic_relevance text NOT NULL CHECK (portomatic_relevance IN ('relevant', 'adjacent', 'not_relevant')),
  identity_confidence text NOT NULL CHECK (identity_confidence IN ('high', 'medium', 'low', 'unknown')),
  review_status text NOT NULL CHECK (review_status IN ('confirmed', 'provisional', 'rejected')),
  evidence text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_segment_id IS NULL OR parent_segment_id <> segment_id),
  UNIQUE (recording_id, segment_id)
);

CREATE INDEX IF NOT EXISTS recording_segments_recording_time_idx
  ON recording_segments(recording_id, start_ms);
CREATE INDEX IF NOT EXISTS recording_segments_call_idx
  ON recording_segments(call_id) WHERE call_id IS NOT NULL;

CREATE OR REPLACE VIEW conversation_catalog AS
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
LEFT JOIN calls c USING (call_id)
LEFT JOIN customers cu ON cu.customer_id = c.primary_customer_id
WHERE rs.parent_segment_id IS NULL;

CREATE OR REPLACE VIEW recording_timeline AS
SELECT
  rs.segment_id,
  rs.parent_segment_id,
  rs.call_id,
  ro.source_id,
  ro.storage_uri AS recording_uri,
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
JOIN recording_objects ro USING (recording_id);

INSERT INTO schema_migrations(migration_name)
VALUES ('002_recording_sources_and_segments.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
