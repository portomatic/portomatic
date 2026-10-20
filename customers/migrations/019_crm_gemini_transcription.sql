BEGIN;
ALTER TABLE crm_transcription_jobs DROP CONSTRAINT crm_transcription_jobs_status_check;
ALTER TABLE crm_transcription_jobs ADD CONSTRAINT crm_transcription_jobs_status_check CHECK(status IN ('queued','running','complete','failed','superseded'));
ALTER TABLE crm_transcription_jobs ALTER COLUMN provider SET DEFAULT 'google';
ALTER TABLE crm_transcription_jobs ALTER COLUMN model SET DEFAULT 'gemini-3.5-transcribe';
ALTER TABLE crm_transcription_jobs ALTER COLUMN options SET DEFAULT '{"mode":"VERBATIM","diarization":true,"wordTimestamp":true,"chunk_ms":840000}'::jsonb;
-- Preserve old jobs, prepared audio and transcripts; replace only pending work.
UPDATE crm_transcription_jobs SET status='superseded',finished_at=now(),error='Replaced by Gemini transcription' WHERE provider='deepgram' AND status='queued';
INSERT INTO schema_migrations(migration_name) VALUES ('019_crm_gemini_transcription.sql');
COMMIT;
