BEGIN;
CREATE TABLE crm_speaker_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES crm_transcripts(run_id),
  input_hash text NOT NULL,
  input_snapshot jsonb NOT NULL,
  policy_version text NOT NULL,
  model text NOT NULL,
  rerun_key text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  video_context jsonb,
  result jsonb,
  artifact jsonb,
  error text,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(run_id,input_hash,policy_version,model,rerun_key)
);
CREATE INDEX crm_speaker_queue ON crm_speaker_jobs(status,available_at);
CREATE UNIQUE INDEX crm_speaker_current ON crm_speaker_jobs(run_id) WHERE is_current;
CREATE TABLE crm_speaker_assignments (
  job_id uuid NOT NULL REFERENCES crm_speaker_jobs(job_id),
  lease_token uuid NOT NULL,
  run_id uuid NOT NULL,
  sequence integer NOT NULL,
  name text NOT NULL CHECK(length(trim(name))>0),
  confidence text NOT NULL CHECK(confidence IN ('high','medium')),
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY(job_id,lease_token,sequence),
  FOREIGN KEY(run_id,sequence) REFERENCES crm_transcript_segments(run_id,sequence)
);
CREATE VIEW crm_named_transcript_segments AS
 SELECT s.*,s.speaker AS original_speaker,
   coalesce(a.name,s.speaker) AS display_speaker,
   a.name AS inferred_name,a.confidence AS name_confidence,a.reason AS name_reason,
   a.evidence AS name_evidence,j.job_id AS speaker_job_id,j.model AS speaker_model
 FROM crm_transcript_segments s
 LEFT JOIN crm_speaker_jobs j ON j.run_id=s.run_id AND j.is_current AND j.status='complete'
 LEFT JOIN crm_speaker_assignments a ON a.job_id=j.job_id AND a.lease_token=j.lease_token AND a.run_id=s.run_id AND a.sequence=s.sequence;
INSERT INTO schema_migrations(migration_name) VALUES ('020_crm_speaker_agents.sql');
COMMIT;
