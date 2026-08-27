# Customer research

This directory is Portomatic's private, repo-native index of customer conversations. Raw media is stored in a private Google Cloud Storage bucket; Git stores the call log and timestamped transcript segments.

## Data model

[`call-log.csv`](call-log.csv) is the canonical index. Each row is one timestamped transcript segment. Recording metadata repeats intentionally so the CSV remains portable and queryable without another database.

| Column | Meaning |
|---|---|
| `call_id` | Stable ID shared by every segment in one customer conversation |
| `customer_slug` | Filesystem-safe customer identifier |
| `customer_name` | Human-readable participant or company name |
| `recorded_at` | ISO 8601 recording timestamp, including timezone |
| `recording_uri` | Durable `gs://` object URI; never a signed HTTPS URL |
| `recording_sha256` | SHA-256 of the original local recording |
| `recording_bytes` | Original file size |
| `recording_duration_seconds` | Full recording duration |
| `segment_start_seconds` | Recording-relative transcript start |
| `segment_end_seconds` | Recording-relative transcript end |
| `speaker` | Speaker label when known |
| `transcript` | Transcript text for the segment |
| `transcript_status` | `pending`, `partial`, or `complete` |
| `source` | Original filename or transcript source, without a local absolute path |

One screen recording may contain multiple customer conversations. Upload it once, then reuse the same `recording_uri` for each call while giving each customer conversation its own `call_id` and recording-relative segment timestamps.

## Security model

- The bucket uses uniform bucket-level access.
- Public access prevention is enforced.
- Bucket versioning and 30-day soft deletion are enabled.
- Founders upload and sign through separate least-privilege service accounts using impersonation. No service-account keys are created.
- The signer can only read objects. The uploader can manage objects but cannot change bucket policy.
- Signed URLs default to 15 minutes and are never written to Git.
- Generated HTML viewers are written to a mode-`0700` temporary directory with mode-`0600` files.
- Raw video and audio extensions are ignored throughout `customers/` as a final guard against accidental Git commits.

Anyone holding a signed URL can watch its object until the URL expires. Treat generated URLs as temporary credentials.

GitHub permissions apply to the entire repository. Do not grant repository access to someone who should not be able to read customer notes or transcripts.

## Configuration

1. Authenticate `gcloud` with a Portomatic company identity.
2. Copy `customers/config.example.env` to `customers/.env`.
3. Fill in the Portomatic organization, project, bucket, and founder principals.
4. Keep `customers/.env` local; it is ignored by Git.

The provisioning script refuses to proceed unless the selected project is directly owned by the configured Google Cloud organization.

## Provision private storage

```sh
npm run customers:provision
npm run customers:verify-storage
```

Provisioning is idempotent. It creates or hardens the bucket, creates uploader and signer service accounts, and lets the configured founder principals impersonate only those accounts.

## Upload a recording

```sh
npm run customers:upload -- \
  --file "/path/to/recording.mov" \
  --call-id "2026-08-20-mitchell-jackson" \
  --customer-name "Mitchell Jackson" \
  --customer-slug "mitchell-jackson" \
  --recorded-at "2026-08-20T12:30:52-07:00" \
  --recording-start "00:00:43" \
  --recording-end "00:27:06"
```

Add `--transcript-vtt /path/to/transcript.vtt` to import timestamped WebVTT cues during upload. Without a VTT file, the script adds a `pending` row that can be replaced later.

If the WebVTT timestamps start at zero for a clipped excerpt, use `--transcript-offset 00:29:32` to convert them to recording-relative timestamps.

Use `--object-key` when one source recording contains multiple calls and should live at a shared object key. Upload the file once; subsequent call-log rows can reuse its `gs://` URI.

Import or replace a transcript after upload:

```sh
npm run customers:import-transcript -- \
  --call-id 2026-08-20-mitchell-jackson \
  --vtt /path/to/transcript.vtt \
  --offset 00:00:43
```

If the call references multiple recordings, also pass `--recording-uri gs://...`.

## Review a call

Generate one temporary timestamped URL:

```sh
npm run customers:url -- --call-id 2026-08-20-mitchell-jackson --at 00:15:17
```

Generate a private local HTML viewer whose transcript rows seek the video to their exact timestamps:

```sh
npm run customers:open -- --call-id 2026-08-20-mitchell-jackson --open
```

The viewer embeds a short-lived signed URL. Regenerate it after expiration.

## Validate the database

```sh
npm run customers:validate
npm test
```

Validation rejects public or signed HTTPS URLs, inconsistent metadata, invalid timestamps, transcript segments outside the recording, and malformed customer identifiers.
