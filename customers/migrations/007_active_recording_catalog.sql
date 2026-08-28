BEGIN;

CREATE OR REPLACE VIEW active_call_recordings AS
SELECT cr.call_id, cr.recording_id, cr.sequence, cr.manifest_uri
FROM call_recordings cr
JOIN recording_objects ro USING (recording_id)
WHERE ro.source_id IS NULL
OR EXISTS (
  SELECT 1
  FROM recording_segments rs
  JOIN recording_source_manifests rsm USING (manifest_id)
  WHERE rs.call_id = cr.call_id
    AND rs.recording_id = cr.recording_id
    AND rsm.is_current
    AND rs.review_status IN ('confirmed', 'provisional')
    AND rs.portomatic_relevance <> 'not_relevant'
);

CREATE OR REPLACE VIEW active_calls AS
SELECT c.*
FROM calls c
WHERE EXISTS (
  SELECT 1 FROM active_call_recordings acr WHERE acr.call_id = c.call_id
);

DROP VIEW IF EXISTS call_catalog;
DROP VIEW IF EXISTS current_transcript_segments;

CREATE VIEW current_transcript_segments AS
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
JOIN active_call_recordings acr USING (call_id, recording_id)
JOIN calls c USING (call_id)
JOIN customers cu ON cu.customer_id = c.primary_customer_id
JOIN recording_objects ro USING (recording_id)
WHERE tr.is_current;

CREATE VIEW call_catalog AS
SELECT
  c.call_id,
  c.title,
  cu.slug AS customer_slug,
  cu.name AS customer_name,
  c.recorded_at,
  count(DISTINCT acr.recording_id) AS recording_count,
  count(DISTINCT tr.transcript_run_id) FILTER (WHERE tr.is_current) AS current_transcript_count,
  count(ts.segment_id) FILTER (WHERE tr.is_current) AS segment_count
FROM active_calls c
JOIN customers cu ON cu.customer_id = c.primary_customer_id
LEFT JOIN active_call_recordings acr USING (call_id)
LEFT JOIN transcript_runs tr ON tr.call_id = acr.call_id AND tr.recording_id = acr.recording_id
LEFT JOIN transcript_segments ts ON ts.transcript_run_id = tr.transcript_run_id
GROUP BY c.call_id, c.title, cu.slug, cu.name, c.recorded_at;

INSERT INTO schema_migrations(migration_name)
VALUES ('007_active_recording_catalog.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
