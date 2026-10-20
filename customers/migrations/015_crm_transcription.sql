BEGIN;
CREATE TABLE crm_transcription_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  touchpoint_id uuid NOT NULL REFERENCES crm_touchpoints(touchpoint_id),
  storage_uri text NOT NULL,
  object_generation bigint NOT NULL,
  source_sha256 text NOT NULL,
  provider text NOT NULL DEFAULT 'deepgram',
  model text NOT NULL DEFAULT 'nova-3',
  options jsonb NOT NULL DEFAULT '{"diarize":true,"utterances":true,"smart_format":true,"detect_language":true}',
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed')),
  reason text NOT NULL DEFAULT 'automatic',
  requested_by text,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  prepared_audio jsonb,
  response_artifact jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX crm_transcription_one_active ON crm_transcription_jobs(touchpoint_id) WHERE status IN ('queued','running');
CREATE INDEX crm_transcription_queue ON crm_transcription_jobs(status,available_at);
CREATE TABLE crm_transcripts (
  run_id uuid PRIMARY KEY REFERENCES crm_transcription_jobs(job_id),
  touchpoint_id uuid NOT NULL REFERENCES crm_touchpoints(touchpoint_id),
  provider text NOT NULL,
  model text NOT NULL,
  model_info jsonb NOT NULL,
  artifact_uri text NOT NULL,
  artifact_generation bigint NOT NULL,
  artifact_sha256 text NOT NULL,
  audio_duration_ms bigint NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_transcripts_current ON crm_transcripts(touchpoint_id) WHERE is_current;
CREATE TABLE crm_transcript_segments (
  run_id uuid NOT NULL REFERENCES crm_transcripts(run_id),
  sequence integer NOT NULL,
  start_ms bigint NOT NULL CHECK(start_ms>=0),
  end_ms bigint NOT NULL CHECK(end_ms>=start_ms),
  speaker text,
  transcript text NOT NULL,
  confidence double precision,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english',transcript)) STORED,
  PRIMARY KEY(run_id,sequence)
);
CREATE INDEX crm_transcript_search ON crm_transcript_segments USING gin(search_document);
INSERT INTO schema_migrations(migration_name) VALUES ('015_crm_transcription.sql');
COMMIT;
