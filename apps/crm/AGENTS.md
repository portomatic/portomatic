# Portomatic CRM

- Serve the shared dashboard at https://crm.portomatic.com behind Cloudflare Access, restricted to Kevin and Zach's @portomatic.com accounts. Verify Access JWTs at the origin and bind the service to loopback. Keep http://crm.localhost available for local work. Never expose anonymous customer data.
- Cloud SQL is the shared source of truth for both founders. Never put customer exports, OAuth tokens, or recordings in Git. Local runtime files belong in ignored `.state/` with private file permissions.
- Use `node apps/crm/cli.mjs` or the loopback API for CRM work. Both use the same cloud tables as the dashboard. Check results after writes.
- Use `node apps/crm/cli.mjs transcripts --query "..."` for current recording-wide transcripts with timestamps and speaker labels. `transcription-status` reports the durable queue. `transcribe --recording UUID` requests a versioned rerun. The cloud worker transcribes indexed originals independently of customer classification; never label sampled or partial legacy text a full transcript.
- Preserve raw recordings and source evidence. Attach corrections and identity links separately. Do not infer customer status from being in the historical `customers` table.
- Keep ingestion from Gmail, Calendar, and Drive read-only. Do not send email, change meetings, or modify Drive files as part of CRM sync.
- Use existing connected Google apps for agent imports. Keep account setup, OAuth clients, import paths and infrastructure configuration out of the dashboard. Preserve source account and owner; do not label a partial import as a complete or unattended sync.
- Match recordings to meetings automatically using explicit source IDs or a unique match with the same founder, capture time and substantial overlap. Keep inferred associations distinct from source-confirmed links. Ambiguous recordings stay available without a review queue. Preserve rejected matches and raw sources.
- Keep the interface compact and quiet, like me.localhost: neutral colors, ordinary tables, minimal controls, no decorative cards or inline dot separators.
