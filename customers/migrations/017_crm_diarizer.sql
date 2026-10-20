BEGIN;
ALTER TABLE crm_transcription_jobs ALTER COLUMN options SET DEFAULT '{"diarize_model":"latest","utterances":true,"smart_format":true,"detect_language":true}';
UPDATE crm_transcription_jobs SET options=(options-'diarize')||'{"diarize_model":"latest"}'::jsonb
 WHERE provider='deepgram' AND status='queued' AND response_artifact IS NULL;
INSERT INTO schema_migrations(migration_name) VALUES ('017_crm_diarizer.sql');
COMMIT;
