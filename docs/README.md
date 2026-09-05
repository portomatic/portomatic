# Portomatic engineering documentation

The architecture, research, and implementation tracker live in this repository:

- [Apple Process Architecture](index.html)
- [Running Apple on Linux](running-apple-on-linux.html)
- [iOS on Linux: MVP Layers](ios-on-linux-mvp.html)
- [Implementation v0](implementation-v0.html)

From the repository root, run `npm run docs:dev`, then open
http://127.0.0.1:8765/. This serves the site only on localhost and starts one
dashboard collector. Stop both with Ctrl-C. Python 3.10+, Git, and an authenticated
GitHub CLI (`gh`) are required for live collection; no npm install is needed.
Use `npm run docs:dev -- --no-collect` to read the docs without collection.
Use `--port 8766` if another server already owns the default port.

The collector follows `origin/codex/portomatic-runtime-v0`, fetches periodically,
and discovers registered worktrees. The checkout's current branch does not select
the monitored baseline. Override it with `--ref`, or monitor another checkout
with `--repository /path/to/portomatic`. Session activity is local to the machine;
colleagues will see their own workers. Missing local evidence branches or archives
can limit supplemental information. This is not a centrally shared agent service.

`npm run docs:refresh` refreshes once; `npm run docs:test` runs collector tests.
Generated dashboard data stays local and is not committed. On a fresh clone, the
live dashboard fills in after the first successful collection.

## Research evidence

Citation pages, source URLs, archive indexes, and manifests are versioned here.
The full downloaded research archive (about 3.3 GB at migration) remains at
`docs/evidence/corellium/` locally. Its raw pages, mirrors, repositories, PDFs,
videos, and download logs are ignored by Git. A fresh clone has the documentation
and citations, but offline archive links require those additional files. Original
source links remain in the citation pages and archive index.

The shared capture is in the private GCS bucket
`gs://portomatic-research-400742035256`. To restore it on a coworker's machine:

```sh
gcloud auth login
npm run docs:sync-evidence
npm run docs:dev
```

The signed-in account needs `roles/storage.objectViewer` on that bucket (or
equivalent inherited project access). A bucket administrator can grant that role
to the team's Google group. Do not grant public access. Login is only needed when
credentials are missing or expired; the sync command does not change the active
GCP project or account.

The approximately 3 GB download contains the preserved capture, not a fresh crawl.
Allow about 7 GB free for the download and restored files. The command verifies
the pinned SHA-256 in `docs/evidence/archive.json` before restoring the ignored
directories. Identical existing files are retained; differing local files stop
the restore before it writes any evidence. No files are deleted. After syncing,
the existing local evidence links work offline.

`file_manifest.json` records file paths and hashes for the original captured archive.
The collection script is preserved at `tools/dashboard/archive_corellium.py`;
its optional dependencies are `requests` and `beautifulsoup4`, plus external
download tools used by the selected phase. Run it with `--help` for phase names.
Re-downloading sources may differ from the preserved historical capture.

Maintainers: publish future captures under a new dated GCS prefix and update the
URI and SHA-256 together in `archive.json`. Preserve old objects so an older
documentation checkout can restore its matching evidence.

## Migration

Imported from the local glossary repository at commit `1b1048e`, including its
uncommitted research evidence and archive script. The original `glossary/`
repository is retained as a local backup, not a dependency of this site. Do not
delete it until any unrelated application work and history have been accounted
for. No site has been published.
