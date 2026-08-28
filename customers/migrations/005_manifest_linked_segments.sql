BEGIN;

ALTER TABLE recording_segments
  ADD COLUMN IF NOT EXISTS manifest_id uuid;

UPDATE recording_segments rs
SET manifest_id = current_manifest.manifest_id
FROM recording_source_manifests current_manifest
WHERE current_manifest.recording_id = rs.recording_id
  AND current_manifest.is_current
  AND rs.manifest_id IS NULL;

ALTER TABLE recording_segments
  ALTER COLUMN manifest_id SET NOT NULL,
  ADD CONSTRAINT recording_segments_manifest_fkey
    FOREIGN KEY (manifest_id) REFERENCES recording_source_manifests(manifest_id) ON DELETE RESTRICT;

ALTER TABLE recording_segments
  DROP CONSTRAINT IF EXISTS recording_segments_parent_same_source_call,
  ADD CONSTRAINT recording_segments_parent_same_source_call
    FOREIGN KEY (recording_id, call_id, parent_segment_id)
    REFERENCES recording_segments(recording_id, call_id, segment_id)
    ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS recording_segments_manifest_idx
  ON recording_segments(manifest_id);

INSERT INTO schema_migrations(migration_name)
VALUES ('005_manifest_linked_segments.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
