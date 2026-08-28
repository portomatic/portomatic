BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  company text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  call_id text PRIMARY KEY CHECK (call_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  primary_customer_id uuid NOT NULL REFERENCES customers(customer_id),
  title text NOT NULL,
  recorded_at timestamptz NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_objects (
  recording_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_uri text NOT NULL UNIQUE CHECK (storage_uri ~ '^gs://[a-z0-9][a-z0-9._-]+/.+'),
  object_generation bigint NOT NULL CHECK (object_generation > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes > 0),
  duration_ms bigint NOT NULL CHECK (duration_ms > 0),
  recorded_at timestamptz NOT NULL,
  source_filename text NOT NULL,
  content_type text NOT NULL,
  gcs_crc32c text,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_uri, object_generation),
  UNIQUE (sha256, bytes)
);

CREATE TABLE IF NOT EXISTS call_recordings (
  call_id text NOT NULL REFERENCES calls(call_id) ON DELETE RESTRICT,
  recording_id uuid NOT NULL REFERENCES recording_objects(recording_id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence >= 1),
  manifest_uri text NOT NULL UNIQUE CHECK (manifest_uri ~ '^gs://[a-z0-9][a-z0-9._-]+/.+'),
  PRIMARY KEY (call_id, recording_id),
  UNIQUE (call_id, sequence)
);

CREATE TABLE IF NOT EXISTS transcript_runs (
  transcript_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id text NOT NULL,
  recording_id uuid NOT NULL,
  artifact_uri text NOT NULL UNIQUE CHECK (artifact_uri ~ '^gs://[a-z0-9][a-z0-9._-]+/.+'),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  model text NOT NULL,
  language text,
  status text NOT NULL CHECK (status IN ('partial', 'complete', 'failed')),
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (call_id, recording_id) REFERENCES call_recordings(call_id, recording_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS transcript_runs_one_current
  ON transcript_runs(call_id, recording_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS transcript_segments (
  segment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transcript_run_id uuid NOT NULL REFERENCES transcript_runs(transcript_run_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 1),
  start_ms bigint NOT NULL CHECK (start_ms >= 0),
  end_ms bigint NOT NULL CHECK (end_ms >= start_ms),
  speaker text,
  transcript text NOT NULL,
  confidence real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(transcript, ''))) STORED,
  UNIQUE (transcript_run_id, sequence)
);

CREATE INDEX IF NOT EXISTS calls_recorded_at_idx ON calls(recorded_at DESC);
CREATE INDEX IF NOT EXISTS transcript_segments_run_time_idx ON transcript_segments(transcript_run_id, start_ms);
CREATE INDEX IF NOT EXISTS transcript_segments_search_idx ON transcript_segments USING gin(search_document);

CREATE OR REPLACE FUNCTION reject_recording_object_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recording objects are immutable; insert a new object instead';
END;
$$;

DROP TRIGGER IF EXISTS recording_objects_are_immutable ON recording_objects;
CREATE TRIGGER recording_objects_are_immutable
BEFORE UPDATE OR DELETE ON recording_objects
FOR EACH ROW EXECUTE FUNCTION reject_recording_object_mutation();

CREATE OR REPLACE VIEW current_transcript_segments AS
SELECT
  c.call_id,
  c.title,
  c.recorded_at AS call_recorded_at,
  cu.slug AS customer_slug,
  cu.name AS customer_name,
  ro.storage_uri AS recording_uri,
  ro.recorded_at AS recording_recorded_at,
  ro.duration_ms AS recording_duration_ms,
  tr.transcript_run_id,
  tr.model,
  tr.status AS transcript_status,
  ts.sequence,
  ts.start_ms,
  ts.end_ms,
  ts.speaker,
  ts.transcript,
  ts.search_document
FROM transcript_runs tr
JOIN transcript_segments ts USING (transcript_run_id)
JOIN calls c USING (call_id)
JOIN customers cu ON cu.customer_id = c.primary_customer_id
JOIN recording_objects ro USING (recording_id)
WHERE tr.is_current;

CREATE OR REPLACE VIEW call_catalog AS
SELECT
  c.call_id,
  c.title,
  cu.slug AS customer_slug,
  cu.name AS customer_name,
  c.recorded_at,
  count(DISTINCT cr.recording_id) AS recording_count,
  count(DISTINCT tr.transcript_run_id) FILTER (WHERE tr.is_current) AS current_transcript_count,
  count(ts.segment_id) FILTER (WHERE tr.is_current) AS segment_count
FROM calls c
JOIN customers cu ON cu.customer_id = c.primary_customer_id
LEFT JOIN call_recordings cr USING (call_id)
LEFT JOIN transcript_runs tr ON tr.call_id = cr.call_id AND tr.recording_id = cr.recording_id
LEFT JOIN transcript_segments ts ON ts.transcript_run_id = tr.transcript_run_id
GROUP BY c.call_id, c.title, cu.slug, cu.name, c.recorded_at;

INSERT INTO schema_migrations(migration_name)
VALUES ('001_customer_calls.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
