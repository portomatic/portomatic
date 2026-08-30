#!/usr/bin/env node
import { queryRows } from "../../customers/scripts/lib/db.mjs";

const rows = await queryRows("SELECT source_filename, captured_at, classification, source_kind, duration_ms, bytes, storage_uri, sha256 FROM media_archive_catalog ORDER BY captured_at DESC;");
console.table(rows.map((row) => ({
  captured_at: row.captured_at,
  classification: row.classification,
  kind: row.source_kind,
  size_gib: (Number(row.bytes) / 1024 / 1024 / 1024).toFixed(2),
  source_filename: row.source_filename,
  storage_uri: row.storage_uri,
  sha256: row.sha256,
})));
