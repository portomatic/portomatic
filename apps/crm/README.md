# Portomatic CRM

Open **https://crm.portomatic.com** and sign in as `kevin@portomatic.com` or `zach@portomatic.com`. Cloudflare Access checks the account, and the origin verifies its signed JWT, CRM audience, issuer and expiration on every route. The dedicated CRM VM exposes no public web port. The local dashboard at **http://crm.localhost** remains available on this Mac. Both use the shared `portomatic_calls` Cloud SQL database.

## Everyday use

- **Timeline** searches email, meetings, LinkedIn messages, notes, documents and recordings.
- **People** opens a person's history. Company and relationship are editable; duplicate profiles can be merged explicitly without changing raw imports; an imported connection is never automatically called a customer.
- **Companies** opens saved research lists, initially **YC companies with Slack bots**. The default evidence filter shows the 79 published matches; other evidence tiers expose early access, YC-only leads, adjacent integrations, and historical/excluded products. Search and filter by use case or founder. Open a company for research sources, YC membership, matched people, history, and editable relationship, owner, notes, and next step. Company pages have shareable `#companies?list=…&company=…` URLs.
- Company associations from exact normalized names, unique company email domains, or historical account names are **possible matches**. Confirm or dismiss them explicitly, or search for a person and confirm a link. Imported LinkedIn connections identify which founder's export contains the connection; they do not prove current employment. Merging people preserves company decisions through the surviving identity. Future imports can introduce new possible matches automatically.
- **Recordings** opens each file directly in GCP in a new tab. Timeline entries open their source, or their linked recording when available.
Recordings are associated with calendar meetings automatically using exact source IDs or an unambiguous match on founder, local capture time and overlap. Ambiguous recordings remain accessible without a review task; inferred calendar context stays separate from source-confirmed relationships.

Account setup is handled outside this dashboard. Use the host application's existing Gmail, Calendar and Drive connections for agent imports, then write source-backed items through the CLI or `/api/import`. Preserve the source account and founder on every import. These agent connections are not credentials available to the standalone Node process, so an agent import must not be described as continuous background Google sync. Previously authorized local Google accounts can continue syncing through the existing adapter; the dashboard does not expose OAuth setup or client-JSON upload forms.

This Mac watches newly finished `Screen Recording ... .mov` / `.mp4` files in its selected recording folder. Files must stay stable for 30 seconds and have readable media metadata before upload. Existing recordings can be added by full local path. Original SHA-256, local and cloud MD5, bytes, and object generation are checked before indexing. No local recordings are deleted.

Uploads in either configured GCP recording bucket are scanned every minute by the cloud service. Cloud SQL is checked every 15 seconds and the visible page refreshes every 20 seconds. Timeline and recording views open from a saved result while cloud data refreshes in the background; the displayed update time belongs to that result. New files appear after their checksum verification finishes. Cloud scanning and transcription continue with both Macs asleep; local recording uploads require the recording Mac to be awake. New raw files are streamed at their pinned generation to compute hashes and added to the media catalog. `portomatic-uploader-email` metadata supplies the owner; absent metadata stays unknown. The metadata can also supply `portomatic-classification`. The standard upload command sets both.

Every indexed original automatically receives a full Google Gemini 3.5 Transcribe job using the existing GCP runtime identity. The worker extracts the complete audio track as lossless FLAC and retains source hashes and generations. VERBATIM mode preserves fillers and spoken corrections, with speaker labels and word timestamps. Files with these features are limited to 15 minutes, so longer calls use gapless 14-minute chunks; every chunk must succeed before a new recording-wide transcript becomes current. Speaker labels are local to each chunk (for example, `Part 2 / spk:1`), never verified identities across parts. Google documents a possible accuracy tradeoff with word timestamps; benchmark results without those features are not a measured guarantee for this pipeline. Per-chunk audio and unmodified provider responses, requested options, model versions, usage and response IDs are archived. When an experimental word end precedes its onset, its duration is treated as unknown (zero span at the supplied onset); the original offsets and correction count remain in run provenance. Out-of-bounds times, missing chunk coverage and truncated responses still block activation. Completed chunks resume after an interruption. The cloud worker runs four calls concurrently (`CRM_TRANSCRIPTION_CONCURRENCY`, capped at eight), with at most two original downloads/audio preparations at once; it fills free slots immediately and prioritizes recent calls. Up to two parts of a long call run concurrently, with at most four Gemini requests in flight across the worker. Checkpoint writes are serialized per call; every part must finish before the full transcript becomes current. Prior Deepgram versions and original recordings are preserved. Failed jobs retry up to four attempts; reruns create a new version. No customer/call identity is required.

Use **Transcribe again** on a recording to rerun it. Recording titles still open the original cloud file. Transcript text participates in Timeline search. Agent queries can use `crm transcripts --query ...` for timestamped evidence, `--recording UUID` for one recording, and `crm transcription-status` for progress. These new recording-wide transcripts live in `crm_transcripts` / `crm_transcript_segments`; older call-specific transcripts remain in `transcript_runs` / `transcript_segments`.

LinkedIn ZIP/CSV imports preserve the unchanged archive and content-hashed manifest in GCP, every imported connection/message/profile row in `crm_import_rows`, and a verified archive record in `crm_import_archives`. The ZIP retains all other export files. Connections are matched by LinkedIn profile URL or exact exported email, never name alone. Overlapping exports retain their individual raw rows but deduplicate timeline messages and connections. Export dates are snapshots, not live LinkedIn sync.

## Cofounder setup

Zach can use the shared dashboard immediately through his company login. For automatic local recording uploads on his Mac:

1. Clone this repo and supply the company's existing `customers/.env` and `media/.env` configuration. These hold project settings and are ignored by Git.
2. Install Node 24+, Google Cloud CLI, FFmpeg, and Caddy. Sign in to GCP as an authorized founder with `gcloud auth login`.
3. Run `npm run crm:install`.
4. Have the agent run `npm run crm -- settings --owner zach@toonworld.io` and configure the recording folder if needed. Account connections are managed in the host application's settings.

The configured authorized founder identity is `zach@toonworld.io`; Google data accounts can have different email addresses and remain attributed to Zach. His recordings go into the same company buckets. Agent imports of his Google data go into the same database. There is no requirement to route his Google credentials through Kevin's Mac.

## Agent / command access

Run commands from the repository root. These use exactly the same cloud data as the dashboard:

```sh
npm run crm -- status
npm run crm -- list
npm run crm -- search --query "Hudson"
npm run crm -- timeline --person PERSON_UUID
npm run crm -- recording --file "/path/to/recording.mov" --owner zach@toonworld.io
npm run crm -- linkedin --file "/path/to/LinkedInExport.zip" --owner zach@toonworld.io
npm run crm:sync
npm run crm -- transcripts --query "onboarding"
npm run crm -- transcribe --recording TOUCHPOINT_UUID
npm run crm -- transcription-status
npm run crm -- research-import --file outputs/yc-slack-bots-2026-10-19/research-data.json
npm run crm -- companies --query "OpenTag"
npm run crm -- companies --list yc-slack-bots --evidence all
```

Research imports use the same Cloud SQL database as both dashboards. Imports preserve the complete dated JSON snapshot and its SHA-256, deduplicate YC company identities and exact snapshots, and keep prospect status, ownership, next steps, notes, and reviewed person links independent of research refreshes. Additional saved lists can be imported with `research-import --slug LIST_SLUG --name "List name" --file FILE`. A list can contain the same company as another list without duplicating the company or its relationship history.

`GET /api/state?view=companies` accepts `list`, `evidence`, `category`, `search`, `owner`, and optional `company`. `POST /api/company` updates `{id,relationship,nextStep,notes,ownerId}`; `POST /api/company/person` records `{companyId,personId,status:"confirmed"|"rejected"}`. The CLI equivalents are `company-update --file FILE.json` and `company-person --company ID --person ID --status confirmed`. Company writes are audited. Research ingestion stays outside the dashboard.

`GET /api/state` accepts `search`, `person`, `kind`, `owner`, and `limit`. Mutations require JSON and reject foreign origins. The server listens only on loopback. `POST /api/import` accepts `{ownerEmail,source,account,items}` for source-backed agent imports. Every item has `kind`, `externalId`, `title`, `occurredAt`, and optional `participants:[{email,name,role}]`, `body`, `url`, `storageUri`, `classification`, and `raw`.

Agent imports require access to the appropriate connected account. Legacy local Google authorization is per Mac/account. Two Macs share the same records; imported IDs and archive hashes prevent duplication. Local-path imports, settings and OAuth setup APIs are disabled on the hosted service.

## Operations

### Local iMessage relationship classification

The Mac-only iMessage preparation and classification commands stage decisions locally; they do not import iMessages into Cloud SQL or send messages to anyone. A contact qualifies for classification when Kevin has sent at least one nonreaction message in a direct conversation. Outgoing-only conversations qualify. Aliases merge only through an unambiguous address-book owner, never a shared name. Incoming-only contacts, self, ambiguous identities, groups and known combined SMS records stay out of model requests.

The ignored, private `.state/never-sync-research.json` supplies the local exclusions. Recommended private contacts, cautious privacy holds and personal-service senders are filtered before message bodies are extracted for requests. Every run rebuilds eligibility from the current policy. Raw histories and any manual-review source snapshots stay local; generated reports, source identifiers and typed decision caches stay in `.state/imessage/` with private permissions. No private contact names or exclusion data belong in Git. Text-encoded reactions in migrated SMS archives do not count as authored messages; sent attachments do.

The private `.state/imessage/manual-verification/reviews.json` ledger takes precedence over model proposals. Manual exclusions apply before body extraction and persist across runs. Manual business approvals require matching conversation and identity fingerprints; changed histories or aliases stay excluded for fresh source review rather than reverting to model approval. Reviewed contacts do not enter model requests. The ledger records assistant judgments from original conversation excerpts, evidence GUIDs, scope and independent outreach flags. Contact eligibility does not authorize syncing personal messages within mixed conversations.

Install the local decoder in a private virtual environment and run:

```sh
python3 -m venv apps/crm/.state/imessage-research-venv
apps/crm/.state/imessage-research-venv/bin/python -m pip install -r apps/crm/requirements-imessage.txt
node apps/crm/cli.mjs imessage-prepare
node apps/crm/cli.mjs imessage-probe
node apps/crm/cli.mjs imessage-classify
node apps/crm/cli.mjs imessage-status
```

`OPENAI_API_KEY` can be supplied to the process. Alternatively, ignored `.state/imessage/api-config.json` can reference an existing key file with `{"key_file":"/private/path/to/api-key"}`, or an environment file with `{"env_file":"/private/path/to/.env","variable":"OPENAI_API_KEY"}`. The key is read into process memory and is not copied into reports. `PORTOMATIC_IMESSAGE_PYTHON` selects a different Python environment.

The classifier uses OpenAI's dedicated `/v1/decisions` endpoint with `gpt-6-luna`. It verifies access with synthetic text before making conversation requests. Remaining eligible conversations are sent to OpenAI for classification, including personal conversations not already identified by the local exclusions. Long histories are processed completely in bounded blocks; unclear results receive a cross-history reconciliation pass where possible. Typed relationship, private-relationship and direct-business answers are combined conservatively. Initial probability thresholds are engineering defaults, not a measured accuracy guarantee. Refusals, malformed answers, missing text, decode failures and API errors remain excluded without a review queue. Calls resume through content-addressed typed-answer caches; request text is not retained in those caches. `--limit N` processes a subset, and `--workers N` controls concurrency.

Read `.state/imessage/classification.html` for the local results, with model proposals and manual reviews labeled separately. `.state/imessage/manual-verification/report.html` preserves the completed contact-by-contact verification and corrections against an immutable model baseline. These reports are not authorization to import unclassified data. Cloud SQL ingestion is a separate step, so preparation or classification alone never uploads the Messages database, contact exclusions or private decisions to the shared CRM.

### Automatic iMessage sync

The Mac's separate `com.portomatic.crm.imessage-sync` LaunchAgent runs every minute while the user session is active. It reads Messages and Contacts without changing them or sending messages. Full readable message text for eligible direct contacts is stored in Cloud SQL under Kevin's account, linked through exact email/phone identities. Attachments, groups, the combined SMS archive, reaction-only contacts, private/service contacts and uncertain relationships remain excluded. Credential patterns are redacted. Text inside an allowed mixed conversation can include personal discussion; contact-level exclusions do not classify each message's topic.

```sh
node apps/crm/cli.mjs imessage-sync-init
node apps/crm/cli.mjs imessage-sync --mode text --dry-run
node apps/crm/cli.mjs imessage-sync-configure --mode text --enabled true
node apps/crm/cli.mjs imessage-sync
bash apps/crm/ops/install-imessage-sync.sh
node apps/crm/cli.mjs imessage-sync-status
```

`--mode metadata` stores contact activity without message bodies. Disable future runs with `imessage-sync-configure --mode text --enabled false`. Configuration and receipts are private files under `.state/imessage/`; the exclusion list itself never goes to Cloud SQL. The effective exclusion policy includes the frozen identities of all manually excluded contacts, preserving blocks when an address-book entry changes or disappears.

Existing manual approvals permit continuing message history for the same reviewed identity, as authorized for continuous sync. The separate classification command still suspends historical approvals when their evidence changes. Newly eligible contacts are automatically evaluated through the existing Decisions API after local exclusions; personal, service, uncertain and failed results stay out. Model decisions are distinct from manual source reviews. A missing policy, identity baseline or incomplete review ledger stops sync.

Message GUIDs and content fingerprints make retries idempotent. Each run reconciles edits, local deletions and revoked eligibility within this owner's iMessage source only, then verifies Cloud SQL counts, links and a complete source-fingerprint digest. Temporary decoding/API failures retain previously uploaded history until the source is readable again. Identity conflicts stay excluded. Rate limits back off automatically. The Mac must be awake and online; this is not a cloud process that can read a sleeping Mac's Messages database.

### Automatic speaker names

`speaker-worker.mjs` starts a bounded, read-only contextual agent for each complete current transcript. It reads the entire transcript, linked meetings and contacts. Its tools can search surrounding CRM history and original transcript passages, read OCR text, or request actual screenshots at selected timestamps from the pinned original video. Screenshots are sent as image inputs to the speaker model on demand, with at most six per request and twelve distinct times per recording shared with OCR requests. Exact JPEG bytes, hashes, source generation and timestamps are retained in private GCS artifacts and reused on reruns. Spoken content and explicit text labels provide identity evidence; it does not perform face or voice recognition. Uploader ownership, rosters, organization placeholders and speaker numbers alone do not establish a name.

Text citations are checked against their source strings. Screenshot citations are accepted only for frames actually delivered to the agent with a pinned image artifact; these are marked `model_read_screenshot` separately from `exact_source_quote`. Reading a name from an image is a model observation, not an independently verified identity or guarantee of correct OCR. Every assignment still requires transcript evidence linking the speaker to the identity.

The worker runs three recordings in parallel. Every proposed mapping cites exact source quotes, uses the original part-scoped labels and an explicit sequence range, and stores qualitative high/medium confidence. Inferred names are attached separately in `crm_speaker_assignments`; `crm_named_transcript_segments` exposes both inferred and original labels to the CLI and protected API. The timeline displays the inferred names without changing file-opening behavior or introducing a review queue. Unsupported speakers remain anonymous. All source snapshots, raw agent responses, tool results, OCR observations and final outputs are retained in private GCS artifacts; original media and provider transcripts are unchanged.

The deployed speaker agent uses **Pool → `gpt-6.1-sol` → medium reasoning**. It calls the existing hosted Pool Responses endpoint, so the worker does not depend on a founder’s Mac being awake. `crm-pool-api-key` in Secret Manager supplies its Pool client credential; `ops/install-speaker-pool.sh` configures only the CRM consumer. Pool keeps its existing account routing and paid-API overflow behavior. Pool usage is not a guaranteed fixed discount, and the response alone does not identify the billing route. The CRM records backend, exact requested/returned model, reasoning effort, usage and raw responses. Truncated SSE streams cannot activate names. Completed Luna results remain available until replacement jobs complete.

The local private `speaker-inference.json` or environment variables `CRM_SPEAKER_BACKEND=pool`, `CRM_SPEAKER_MODEL=gpt-6.1-sol`, `CRM_SPEAKER_REASONING_EFFORT=medium` and `CRM_POOL_KEY_FILE` select the same setup. `CRM_SPEAKER_BACKEND=openai` with `CRM_SPEAKER_MODEL=latest-luna` restores direct Luna routing. Google transcription and Decisions API call classification keep their existing providers.

With direct OpenAI routing, `CRM_SPEAKER_MODEL=latest-luna` checks the authenticated OpenAI model catalog once per day and selects the highest numeric canonical `gpt-<version>-luna` available to that API project. This is our own selection policy, not an OpenAI alias. It excludes previews, dated snapshots and other tiers; a failed refresh retains the previous selection. Set `CRM_SPEAKER_MODEL` to an exact ID to override. Each job records the requested and returned model. New model selections, new transcript runs, or changed linked context enqueue a new version; identical automatic work is deduplicated. Tool-retrieved context is snapshotted per run; new email imports can be incorporated immediately with a forced rerun. The agent has at most five rounds and eight tool executions. Failed/incomplete or invalid responses cannot replace the current result.

```sh
node apps/crm/cli.mjs speaker-status
node apps/crm/cli.mjs name-speakers --backfill
node apps/crm/cli.mjs name-speakers --recording TOUCHPOINT_UUID --force
node apps/crm/cli.mjs name-speakers --backfill --refresh-model
```

Apply migration `020_crm_speaker_agents.sql` and runtime grants before deploying the new server. Deploy `ops/install-speakers.sh` on the dedicated CRM VM to install Tesseract and the `portomatic-speakers` systemd service. The service loads the existing CRM OpenAI credential from `crm-openai-api-key` in Secret Manager into a private runtime file. Locally it accepts `OPENAI_API_KEY`, `CRM_OPENAI_KEY_FILE`, or the existing ignored CRM credential reference.

### YC credentials

`crm-yc-credentials` in Secret Manager holds a copy of the local YC CLI OAuth credential. The CRM runtime service account has accessor permission on that secret. Run `ops/install-yc.sh` as root on the dedicated CRM VM to install the checksum-verified Linux YC CLI and `/usr/local/sbin/crm-load-yc-secret`. The loader writes the credential to the runtime user's `/var/lib/portomatic-crm/.yc/credentials.json` with mode 0600. It keeps YC-refreshed credentials on subsequent runs. After an explicit new local login, add the local credential file as a new secret version and run the loader with `--replace` to activate it. Never log credential payloads or commit them.

The current copied login includes `sales_feedback:manage`; local and cloud sales-feedback access were verified after reauthorization. Credentials are not displayed in the dashboard.

### Automatic sales feedback

`portomatic-sales-feedback` polls complete current transcripts after the speaker-naming pass finishes, or after ten minutes if naming is still unavailable. Two calls can run concurrently on the existing VM. The OpenAI Decisions API (`gpt-6-luna`) evaluates the full literal transcript and CRM/speaker context to distinguish company-side sales and customer discovery from support, internal discussion, networking, fundraising, vendor pitches, other and unclear calls. Sales/discovery probability and company-side role must each be at least 0.9, with primary-support probability at most 0.1. These are initial routing thresholds, not a measured accuracy guarantee. Unsupported, refused and uncertain classifications stay out of YC without a review queue.

Eligible calls upload their full literal transcript through `yc sales-feedback upload --json`. The worker saves the returned report ID and polls `get --json` for completion, rather than keeping an upload open with `--wait`. Classification and full reports are retained in Cloud SQL and private GCS artifacts. A completed report appears as a simple **Sales feedback** link beside its recording in the protected CRM. New transcript versions get a separate job; unchanged automatic work is deduplicated. Polling resumes from the saved ID. Upload stdout is checkpointed privately; an interrupted upload with no recoverable report ID is marked failed rather than blindly duplicated. No email or outreach is sent.

Apply `021_crm_sales_feedback.sql` and runtime grants before deploying the server/worker, then run `ops/install-sales-feedback.sh` on the CRM VM. The service loads the existing YC and OpenAI secrets and continues when both founders' Macs are asleep.

```sh
node apps/crm/cli.mjs sales-feedback
node apps/crm/cli.mjs sales-feedback-status
node apps/crm/cli.mjs sales-feedback-report --recording TOUCHPOINT_UUID
```

### Services

```sh
npm run crm:install       # installs/restarts launchd and Caddy
npm run crm:start         # foreground server for development
```

Launch agent: `com.portomatic.crm`. Log: `~/Library/Logs/portomatic-crm.log`. Local private runtime state: `apps/crm/.state/`. Caddy route: `/opt/homebrew/etc/caddy.d/crm.localhost.caddy`. SQL migrations remain in `customers/migrations/`.

Cloud VM: `portomatic-crm`, `us-central1-a`, project `affable-heading-498721-f4`. Services: `portomatic-crm`, `portomatic-transcription`, `portomatic-crm-tunnel`. The runtime uses its attached `portomatic-crm` service account, never a downloaded credential key. Gemini uses `roles/aiplatform.user` and the enabled Agent Platform API, with no API key. The Cloudflare tunnel token and retained legacy Deepgram key remain in Secret Manager; Zach retains access to the legacy key. Cloudflare configuration is maintained by `ops/cloudflare.py`; it touches CRM resources only, creates protection before DNS, and refuses an unexpected policy or destination. Keep deployment configuration in ignored `.state/`.
