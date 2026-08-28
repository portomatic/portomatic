BEGIN;

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

INSERT INTO schema_migrations(migration_name)
VALUES ('004_segment_bounds.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
