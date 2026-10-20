BEGIN;
CREATE TABLE crm_sales_feedback_jobs (
 job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL REFERENCES crm_transcripts(run_id),
 policy_version text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','polling','complete','skipped','failed')),
 phase text NOT NULL DEFAULT 'classify' CHECK(phase IN ('classify','upload','uploading','poll')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 transcript_sha256 text,
 decision jsonb,
 decision_artifact jsonb,
 report_id text,
 report jsonb,
 report_artifact jsonb,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(run_id,policy_version)
);
CREATE INDEX crm_sales_feedback_queue ON crm_sales_feedback_jobs(status,available_at);
INSERT INTO schema_migrations(migration_name) VALUES ('021_crm_sales_feedback.sql');
COMMIT;
