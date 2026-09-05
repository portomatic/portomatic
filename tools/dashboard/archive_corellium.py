#!/usr/bin/env python3
"""Create a durable, offline Corellium primary-source archive."""

import argparse
import base64
import concurrent.futures
import datetime as dt
import hashlib
import html
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.parse
from pathlib import Path

import requests
from bs4 import BeautifulSoup


HERE = Path(__file__).resolve().parent
SITE = HERE.parents[1] / "docs"
ROOT = SITE / "evidence" / "corellium"
DISCOVERY = ROOT / "discovery.json"
USER_AGENT = "Mozilla/5.0 (compatible; local-research-archive/1.0)"
RELATED_PRIMARY_URLS = [
    "https://projectsandcastle.org/home",
    "https://projectsandcastle.org/history",
    "https://projectsandcastle.org/status",
    "https://developer.arm.com/documentation/ddi0500/j/Programmers-Model/ARMv8-A-architecture-concepts/Exception-levels",
    "https://documentation-service.arm.com/documentation/ddi0500/j/Programmers-Model/ARMv8-A-architecture-concepts/Exception-levels",
    "https://support.apple.com/guide/security/boot-process-for-iphone-and-ipad-devices-secb3000f149/web",
    "https://support.apple.com/guide/security/the-secure-enclave-sec59b0b31ff/web",
]
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})
NOW = lambda: dt.datetime.now(dt.timezone.utc).isoformat()


def mkdirs():
    for path in [
        ROOT,
        ROOT / "raw" / "current",
        ROOT / "raw" / "wayback",
        ROOT / "mirror" / "current",
        ROOT / "mirror" / "wayback" / "pages",
        ROOT / "mirror" / "wayback" / "assets",
        ROOT / "github",
        ROOT / "media",
        ROOT / "documents",
        ROOT / "logs",
    ]:
        path.mkdir(parents=True, exist_ok=True)


def request(url, timeout=60, attempts=4):
    last = None
    for attempt in range(attempts):
        try:
            response = SESSION.get(url, timeout=timeout, allow_redirects=True)
            if response.status_code in (429, 502, 503, 504):
                raise RuntimeError("HTTP %s" % response.status_code)
            response.raise_for_status()
            return response
        except Exception as exc:
            last = exc
            time.sleep(min(8, 1.5 ** attempt))
    raise last


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_segment(value):
    value = urllib.parse.unquote(value).strip("/")
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
    return value or "index"


def url_key(url):
    parsed = urllib.parse.urlsplit(url)
    path = parsed.path.rstrip("/") or "/"
    return parsed.netloc.lower() + path


def raw_path(kind, url):
    parsed = urllib.parse.urlsplit(url)
    path = parsed.path
    if path.endswith("/") or not Path(path).suffix:
        path = path.rstrip("/") + ".html"
    if not path or path == ".html":
        path = "index.html"
    return ROOT / "raw" / kind / parsed.netloc / path.lstrip("/")


def wget_path(url):
    parsed = urllib.parse.urlsplit(url)
    path = urllib.parse.unquote(parsed.path)
    if not path or path.endswith("/"):
        path = path.rstrip("/") + "/index.html"
    elif not Path(path).suffix:
        path += ".html"
    return ROOT / "mirror" / "current" / parsed.netloc / path.lstrip("/")


def existing_current_mirror(url):
    parsed = urllib.parse.urlsplit(url)
    exact = ROOT / "mirror" / "current" / parsed.netloc / urllib.parse.unquote(parsed.path).lstrip("/")
    candidates = [wget_path(url), exact, Path(str(exact) + ".html")]
    if not parsed.path or parsed.path.endswith("/"):
        candidates.append(exact / "index.html")
    return next((path for path in candidates if path.exists() and path.is_file()), None)


def extract_title(data, fallback):
    try:
        soup = BeautifulSoup(data, "html.parser")
        if soup.title and soup.title.get_text(strip=True):
            return re.sub(r"\s+", " ", soup.title.get_text(" ", strip=True))
        heading = soup.find(["h1", "h2"])
        if heading:
            return re.sub(r"\s+", " ", heading.get_text(" ", strip=True))
    except Exception:
        pass
    return fallback


def sitemap_urls(url):
    text = request(url).text
    return sorted(set(html.unescape(x) for x in re.findall(r"<loc>(.*?)</loc>", text, re.S)))


def wayback_blog_rows():
    cdx = (
        "https://web.archive.org/cdx/search/cdx?url=corellium.com/blog/*"
        "&output=json&fl=original,timestamp,statuscode,mimetype,digest"
        "&filter=statuscode:200&filter=mimetype:text/html&collapse=urlkey"
    )
    rows = request(cdx, timeout=120).json()[1:]
    chosen = {}
    for original, timestamp, status, mime, digest in rows:
        parsed = urllib.parse.urlsplit(original)
        clean = urllib.parse.urlunsplit(("https", parsed.netloc, parsed.path.rstrip("/") or "/blog", "", ""))
        key = parsed.path.rstrip("/") or "/blog"
        candidate = {
            "original_url": clean,
            "timestamp": timestamp,
            "status": int(status),
            "mime": mime,
            "digest": digest,
            "kind": "listing" if re.search(r"/(?:author|tag|page)(?:/|$)|/rss\.xml$|^/blog$", key) else "post",
        }
        if key not in chosen or timestamp < chosen[key]["timestamp"]:
            chosen[key] = candidate
    return [chosen[key] for key in sorted(chosen)]


def github_repositories():
    repos = []
    page = 1
    while True:
        response = request("https://api.github.com/orgs/corellium/repos?per_page=100&page=%d" % page)
        batch = response.json()
        if not batch:
            break
        repos.extend(batch)
        page += 1
    return repos


def youtube_inventory():
    command = [
        "yt-dlp",
        "--no-update",
        "--flat-playlist",
        "--dump-single-json",
        "https://www.youtube.com/@Corellium-HQ/videos",
    ]
    completed = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return json.loads(completed.stdout)


def discover():
    mkdirs()
    main_urls = sitemap_urls("https://www.corellium.com/sitemap.xml")
    support_urls = sitemap_urls("https://support.corellium.com/sitemap.xml")
    documentation_urls = [
        "https://docs.corellium.com/",
        "https://docs.corellium.com/api/openapi.json",
        "https://docs.corellium.com/api/config.js",
    ]
    wayback_rows = wayback_blog_rows()
    repos = github_repositories()
    youtube = youtube_inventory()
    result = {
        "retrieved_at": NOW(),
        "scope": {
            "main_sitemap": "https://www.corellium.com/sitemap.xml",
            "support_sitemap": "https://support.corellium.com/sitemap.xml",
            "historical_blog_index": "Internet Archive CDX for corellium.com/blog/*",
            "github_org": "https://github.com/corellium",
            "youtube_channel": "https://www.youtube.com/@Corellium-HQ/videos",
            "related_primary_sources": "Project Sandcastle, Arm architecture documentation, and Apple Platform Security pages cited by the article",
        },
        "main_urls": main_urls,
        "support_urls": support_urls,
        "documentation_urls": documentation_urls,
        "related_primary_urls": RELATED_PRIMARY_URLS,
        "wayback_blog": wayback_rows,
        "github_repositories": repos,
        "youtube": youtube,
    }
    write_json(DISCOVERY, result)
    print("discovered", len(main_urls), "main pages,", len(support_urls), "support pages,", len(documentation_urls), "API documentation endpoints,", len(RELATED_PRIMARY_URLS), "related primary-source pages,", len(wayback_rows), "historical blog URLs,", len(repos), "repositories,", len(youtube.get("entries", [])), "videos")


def load_discovery():
    if not DISCOVERY.exists():
        discover()
    return json.loads(DISCOVERY.read_text(encoding="utf-8"))


def save_raw_current(url):
    destination = raw_path("current", url)
    metadata_path = destination.with_suffix(destination.suffix + ".metadata.json")
    if metadata_path.exists():
        cached = json.loads(metadata_path.read_text(encoding="utf-8"))
        if destination.exists() or cached.get("error"):
            return cached
    try:
        response = request(url)
        data = response.content
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        metadata = {
            "source_url": url,
            "final_url": response.url,
            "retrieved_at": NOW(),
            "status": response.status_code,
            "content_type": response.headers.get("content-type"),
            "sha256": sha256_bytes(data),
            "bytes": len(data),
            "title": extract_title(data, url),
            "raw_path": str(destination.relative_to(ROOT)),
        }
    except Exception as exc:
        metadata = {"source_url": url, "retrieved_at": NOW(), "error": str(exc)}
    write_json(metadata_path, metadata)
    return metadata


def mirror_current():
    mkdirs()
    data = load_discovery()
    urls = sorted(set(
        data["main_urls"]
        + data["support_urls"]
        + data.get("documentation_urls", [])
        + data.get("related_primary_urls", RELATED_PRIMARY_URLS)
    ))
    list_path = ROOT / "current_urls.txt"
    list_path.write_text("\n".join(urls) + "\n", encoding="utf-8")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        records = list(pool.map(save_raw_current, urls))
    write_json(ROOT / "current_records.json", records)
    pending_urls = [url for url in urls if not existing_current_mirror(url)]
    pending_path = ROOT / "current_pending_urls.txt"
    pending_path.write_text("\n".join(pending_urls) + ("\n" if pending_urls else ""), encoding="utf-8")
    log_path = ROOT / "logs" / "wget-current.log"
    if not pending_urls:
        print("current mirror already complete", "records", len(records))
        return
    command = [
        "wget",
        "--input-file", str(pending_path),
        "--directory-prefix", str(ROOT / "mirror" / "current"),
        "--page-requisites",
        "--convert-links",
        "--adjust-extension",
        "--span-hosts",
        "--no-clobber",
        "--timeout=30",
        "--tries=2",
        "--user-agent=" + USER_AGENT,
        "--append-output=" + str(log_path),
    ]
    result = subprocess.run(command)
    print("current mirror wget exit", result.returncode, "records", len(records))


ASSET_ATTRS = {
    "script": ["src"],
    "img": ["src", "data-src"],
    "source": ["src"],
    "video": ["src", "poster"],
    "audio": ["src"],
    "embed": ["src"],
    "object": ["data"],
    "link": ["href"],
}


def asset_filename(url, content_type=""):
    parsed = urllib.parse.urlsplit(url)
    suffix = Path(parsed.path).suffix.lower()
    if not suffix or len(suffix) > 8:
        suffix = mimetypes.guess_extension((content_type or "").split(";", 1)[0].strip()) or ".bin"
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:24] + suffix


def fetch_wayback_page(row):
    original = row["original_url"]
    timestamp = row["timestamp"]
    replay = "https://web.archive.org/web/%sid_/%s" % (timestamp, original)
    slug = safe_segment(urllib.parse.urlsplit(original).path.replace("/blog/", ""))
    destination = ROOT / "raw" / "wayback" / (slug + ".html")
    metadata_path = destination.with_suffix(".metadata.json")
    if destination.exists() and metadata_path.exists():
        return json.loads(metadata_path.read_text(encoding="utf-8"))
    try:
        response = request(replay, timeout=120)
        content = response.content
        destination.write_bytes(content)
        metadata = dict(row)
        metadata.update({
            "replay_url": replay,
            "retrieved_at": NOW(),
            "sha256": sha256_bytes(content),
            "bytes": len(content),
            "title": extract_title(content, original),
            "raw_path": str(destination.relative_to(ROOT)),
            "slug": slug,
        })
    except Exception as exc:
        metadata = dict(row)
        metadata.update({"retrieved_at": NOW(), "error": str(exc), "slug": slug})
    write_json(metadata_path, metadata)
    return metadata


def archived_asset_url(timestamp, url):
    return "https://web.archive.org/web/%sid_/%s" % (timestamp, url)


def download_asset(url, timestamp, registry):
    key = url
    if key in registry and registry[key].get("path") and (ROOT / registry[key]["path"]).exists():
        return registry[key]
    candidates = [archived_asset_url(timestamp, url), url]
    error = None
    for candidate in candidates:
        try:
            response = request(candidate, timeout=45, attempts=1)
            content_type = response.headers.get("content-type", "")
            filename = asset_filename(url, content_type)
            destination = ROOT / "mirror" / "wayback" / "assets" / filename
            destination.write_bytes(response.content)
            record = {
                "source_url": url,
                "retrieved_from": response.url,
                "retrieved_at": NOW(),
                "content_type": content_type,
                "bytes": len(response.content),
                "sha256": sha256_bytes(response.content),
                "path": str(destination.relative_to(ROOT)),
            }
            registry[key] = record
            return record
        except Exception as exc:
            error = str(exc)
    record = {"source_url": url, "retrieved_at": NOW(), "error": error}
    registry[key] = record
    return record


def mirror_wayback():
    mkdirs()
    data = load_discovery()
    rows = data["wayback_blog"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(fetch_wayback_page, rows))
    write_json(ROOT / "wayback_records.json", records)
    registry_path = ROOT / "wayback_assets.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.exists() else {}
    records.sort(key=lambda item: (item.get("kind") != "post", item.get("title") or item.get("original_url") or ""))
    for index, record in enumerate(records, 1):
        if record.get("error") or not record.get("raw_path"):
            continue
        source = ROOT / record["raw_path"]
        soup = BeautifulSoup(source.read_bytes(), "html.parser")
        original = record["original_url"]
        timestamp = record["timestamp"]
        if record.get("kind") == "listing":
            output = ROOT / "mirror" / "wayback" / "pages" / record["slug"] / "index.html"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(str(soup), encoding="utf-8")
            record["mirror_path"] = str(output.relative_to(ROOT))
            record["offline_assets"] = "not collected for listing/index page"
            continue
        asset_targets = []
        srcset_targets = []
        asset_urls = set()
        for tag_name, attrs in ASSET_ATTRS.items():
            for tag in soup.find_all(tag_name):
                if tag_name == "link":
                    rel = " ".join(tag.get("rel", []))
                    if not any(word in rel for word in ["stylesheet", "icon", "preload", "manifest"]):
                        continue
                for attr in attrs:
                    value = tag.get(attr)
                    if not value or value.startswith(("data:", "javascript:", "mailto:", "#")):
                        continue
                    absolute = urllib.parse.urljoin(original, value)
                    parsed = urllib.parse.urlsplit(absolute)
                    if parsed.scheme not in ("http", "https"):
                        continue
                    asset_targets.append((tag, attr, absolute))
                    asset_urls.add(absolute)
        for tag in soup.find_all(["img", "source"]):
            if tag.get("srcset"):
                entries = []
                for item in tag["srcset"].split(","):
                    parts = item.strip().split()
                    if not parts:
                        continue
                    absolute = urllib.parse.urljoin(original, parts[0])
                    entries.append((parts, absolute))
                    asset_urls.add(absolute)
                srcset_targets.append((tag, entries))
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            downloaded = list(pool.map(lambda url: (url, download_asset(url, timestamp, registry)), sorted(asset_urls)))
        assets_by_url = dict(downloaded)
        for tag, attr, absolute in asset_targets:
            asset = assets_by_url[absolute]
            if asset.get("path"):
                tag[attr] = "../../assets/" + Path(asset["path"]).name
        for tag, entries in srcset_targets:
            rewritten = []
            for parts, absolute in entries:
                asset = assets_by_url[absolute]
                if asset.get("path"):
                    parts[0] = "../../assets/" + Path(asset["path"]).name
                rewritten.append(" ".join(parts))
            tag["srcset"] = ", ".join(rewritten)
        output = ROOT / "mirror" / "wayback" / "pages" / record["slug"] / "index.html"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(str(soup), encoding="utf-8")
        record["mirror_path"] = str(output.relative_to(ROOT))
        if index % 20 == 0:
            write_json(registry_path, registry)
            write_json(ROOT / "wayback_records.json", records)
            print("wayback pages mirrored", index, "/", len(records), "assets", len(registry))
    write_json(registry_path, registry)
    write_json(ROOT / "wayback_records.json", records)


def archive_github():
    mkdirs()
    repos = load_discovery()["github_repositories"]
    records = []
    for index, repo in enumerate(repos, 1):
        name = repo["name"]
        destination = ROOT / "github" / name
        destination.mkdir(parents=True, exist_ok=True)
        write_json(destination / "repository.json", repo)
        archive = destination / (name + "-source.tar.gz")
        record = {
            "name": name,
            "source_url": repo["html_url"],
            "default_branch": repo.get("default_branch"),
            "description": repo.get("description"),
            "archived": repo.get("archived"),
            "retrieved_at": NOW(),
        }
        try:
            if not archive.exists():
                url = "https://api.github.com/repos/corellium/%s/tarball/%s" % (name, repo.get("default_branch") or "HEAD")
                with SESSION.get(url, stream=True, timeout=180, allow_redirects=True) as response:
                    response.raise_for_status()
                    with archive.open("wb") as stream:
                        for chunk in response.iter_content(1024 * 1024):
                            if chunk:
                                stream.write(chunk)
            record.update({"archive_path": str(archive.relative_to(ROOT)), "bytes": archive.stat().st_size, "sha256": sha256_file(archive)})
            with tarfile.open(archive, "r:gz") as tar:
                members = tar.getmembers()
                if members:
                    root_name = members[0].name.split("/", 1)[0]
                    record["snapshot_id"] = root_name.rsplit("-", 1)[-1]
                readmes = [m for m in members if re.search(r"(^|/)README(?:\.[^/]+)?$", m.name, re.I) and m.isfile()]
                if readmes:
                    chosen = min(readmes, key=lambda m: m.name.count("/"))
                    extracted = tar.extractfile(chosen)
                    if extracted:
                        readme = destination / Path(chosen.name).name
                        readme.write_bytes(extracted.read())
                        record["readme_path"] = str(readme.relative_to(ROOT))
        except Exception as exc:
            record["error"] = str(exc)
        records.append(record)
        print("github", index, "/", len(repos), name)
    write_json(ROOT / "github_records.json", records)


def archive_media():
    mkdirs()
    output = str(ROOT / "media" / "%(id)s" / "%(title).180B [%(id)s].%(ext)s")
    log_path = ROOT / "logs" / "yt-dlp.log"
    command = [
        "yt-dlp",
        "--no-update",
        "--ignore-errors",
        "--no-overwrites",
        "--write-info-json",
        "--write-description",
        "--write-thumbnail",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "en.*",
        "--convert-subs", "srt",
        "--embed-metadata",
        "--extractor-args", "youtube:player_client=android",
        "--format", "18/b",
        "--output", output,
        "https://www.youtube.com/@Corellium-HQ/videos",
    ]
    with log_path.open("w", encoding="utf-8") as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    print("media archive exit", result.returncode)


DOCUMENT_RE = re.compile(r"https?://[^\s\"'<>]+\.(?:pdf|zip|tar\.gz|tgz|docx|pptx)(?:\?[^\s\"'<>]*)?", re.I)


def archive_documents():
    mkdirs()
    urls = set()
    for source in (ROOT / "raw").rglob("*.html"):
        try:
            text = source.read_text(encoding="utf-8", errors="ignore")
            urls.update(html.unescape(x) for x in DOCUMENT_RE.findall(text))
        except Exception:
            pass
    records = []
    for index, url in enumerate(sorted(urls), 1):
        parsed = urllib.parse.urlsplit(url)
        basename = safe_segment(Path(parsed.path).name)
        destination = ROOT / "documents" / (hashlib.sha256(url.encode()).hexdigest()[:16] + "-" + basename)
        record = {"source_url": url, "retrieved_at": NOW()}
        try:
            if not destination.exists():
                response = request(url, timeout=180)
                destination.write_bytes(response.content)
            record.update({"path": str(destination.relative_to(ROOT)), "bytes": destination.stat().st_size, "sha256": sha256_file(destination)})
        except Exception as exc:
            record["error"] = str(exc)
        records.append(record)
        if index % 20 == 0:
            print("documents", index, "/", len(urls))
    write_json(ROOT / "document_records.json", records)


def rel_href(path):
    return urllib.parse.quote(str(path).replace(os.sep, "/"), safe="/._-[]()")


def build_index():
    mkdirs()
    discovery = load_discovery()
    current = json.loads((ROOT / "current_records.json").read_text()) if (ROOT / "current_records.json").exists() else []
    wayback = json.loads((ROOT / "wayback_records.json").read_text()) if (ROOT / "wayback_records.json").exists() else []
    github = json.loads((ROOT / "github_records.json").read_text()) if (ROOT / "github_records.json").exists() else []
    documents = json.loads((ROOT / "document_records.json").read_text()) if (ROOT / "document_records.json").exists() else []
    media_info_files = sorted((ROOT / "media").rglob("*.info.json"))
    videos = []
    channel_metadata = []
    for info_path in media_info_files:
        try:
            info_type = json.loads(info_path.read_text(encoding="utf-8")).get("_type")
        except Exception:
            info_type = None
        (channel_metadata if info_type == "playlist" else videos).append(info_path)
    wayback_assets_path = ROOT / "wayback_assets.json"
    wayback_assets = json.loads(wayback_assets_path.read_text()) if wayback_assets_path.exists() else {}

    arm_api_url = "https://documentation-service.arm.com/documentation/ddi0500/j/Programmers-Model/ARMv8-A-architecture-concepts/Exception-levels"
    arm_record = next((item for item in current if item.get("source_url") == arm_api_url and item.get("raw_path")), None)
    if arm_record:
        try:
            payload = json.loads((ROOT / arm_record["raw_path"]).read_text(encoding="utf-8"))
            decoded = base64.b64decode(payload["content"]).decode("utf-8")
            decoded_soup = BeautifulSoup(decoded, "html.parser")
            article = decoded_soup.body.decode_contents() if decoded_soup.body else decoded
            arm_reader = ROOT / "mirror" / "derived" / "arm-exception-levels.html"
            arm_reader.parent.mkdir(parents=True, exist_ok=True)
            arm_reader.write_text(
                "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                "<title>Arm Exception levels</title><link rel=\"stylesheet\" href=\"../../../textbook.css\"></head><body>"
                "<header><h1>Exception levels</h1><p>Decoded from Arm's archived documentation response.</p></header>"
                + article
                + "</body></html>",
                encoding="utf-8",
            )
        except Exception:
            pass

    wget_failures = []
    wget_log = ROOT / "logs" / "wget-current.log"
    if wget_log.exists():
        active_url = None
        for line in wget_log.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r"--.*?--\s+(https?://\S+)", line)
            if match:
                active_url = match.group(1)
            if " ERROR " in line and active_url:
                wget_failures.append({"kind": "wget request", "source_url": active_url, "error": line.strip()})
    write_json(ROOT / "wget_failure_records.json", wget_failures)

    unresolved_requisites = []
    seen_requisites = set()
    for page in (ROOT / "mirror" / "current").rglob("*.html"):
        try:
            page_soup = BeautifulSoup(page.read_bytes(), "html.parser")
        except Exception:
            continue
        for tag_name, attrs in ASSET_ATTRS.items():
            for tag in page_soup.find_all(tag_name):
                if tag_name == "link" and not any(word in " ".join(tag.get("rel", [])) for word in ["stylesheet", "icon", "preload", "manifest"]):
                    continue
                for attr in attrs:
                    value = tag.get(attr)
                    if not isinstance(value, str) or not value.startswith(("http://", "https://", "//", "/")):
                        continue
                    key = (str(page.relative_to(ROOT)), value)
                    if key in seen_requisites:
                        continue
                    seen_requisites.add(key)
                    unresolved_requisites.append({"page": key[0], "source_url": value, "error": "Resource still points to the network; the offline page may omit it."})
    write_json(ROOT / "unresolved_requisites.json", unresolved_requisites)

    def current_mirror_for(record):
        for url in [record.get("source_url"), record.get("final_url")]:
            if not url:
                continue
            candidate = existing_current_mirror(url)
            if candidate:
                return str(candidate.relative_to(ROOT))
        return None

    media_records = []
    for info_path in videos:
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
        except Exception:
            info = {}
        files = []
        for path in sorted(p for p in info_path.parent.iterdir() if p.is_file()):
            files.append({
                "path": str(path.relative_to(ROOT)),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            })
        media_records.append({
            "id": info.get("id") or info_path.parent.name,
            "title": info.get("title") or info_path.stem,
            "source_url": info.get("webpage_url") or "https://www.youtube.com/watch?v=" + info_path.parent.name,
            "retrieved_at": dt.datetime.fromtimestamp(info_path.stat().st_mtime, dt.timezone.utc).isoformat(),
            "files": files,
        })

    failure_records = []
    for item in current:
        if item.get("error"):
            failure_records.append({"kind": "current response", "source_url": item.get("source_url"), "error": item["error"]})
        elif not current_mirror_for(item):
            failure_records.append({"kind": "current offline mirror", "source_url": item.get("source_url"), "error": "No converted offline page; raw response is preserved."})
    for item in wayback:
        if item.get("error"):
            failure_records.append({"kind": "historical response", "source_url": item.get("original_url"), "error": item["error"]})
        elif not item.get("mirror_path"):
            failure_records.append({"kind": "historical offline mirror", "source_url": item.get("original_url"), "error": "Offline page has not been assembled."})
    for item in github:
        if item.get("error"):
            failure_records.append({"kind": "repository", "source_url": item.get("source_url"), "error": item["error"]})
    for item in documents:
        if item.get("error"):
            failure_records.append({"kind": "document", "source_url": item.get("source_url"), "error": item["error"]})
    for item in wayback_assets.values():
        if item.get("error"):
            failure_records.append({"kind": "historical page asset", "source_url": item.get("source_url"), "error": item["error"]})
    failure_records.extend(wget_failures)
    for item in unresolved_requisites:
        failure_records.append({"kind": "unresolved page requisite", **item})
    for info_path in videos:
        media_files = [p for p in info_path.parent.iterdir() if p.suffix.lower() in (".mp4", ".mkv", ".webm") and ".partial-download." not in p.name]
        if not media_files:
            failure_records.append({"kind": "video file", "source_url": "https://www.youtube.com/watch?v=" + info_path.parent.name, "error": "Metadata and available subtitles were preserved, but no complete video file was retrieved."})
    unresolved_count = sum(item.get("kind") == "unresolved page requisite" for item in failure_records)
    failures = len(failure_records) - unresolved_count
    parts = [
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        "<title>Corellium Primary-Source Archive</title><link rel=\"stylesheet\" href=\"../../textbook.css\"></head><body>",
        "<header id=\"top\"><h1>Corellium Primary-Source Archive</h1>",
        "<p>Offline copies, provenance, and checksums. Retrieved %s.</p></header>" % html.escape(discovery.get("retrieved_at", "")),
        "<section><h2>Inventory</h2><ul>",
        "<li>%d current and cited primary-source responses</li>" % len(current),
        "<li>%d historical blog URLs</li>" % len(wayback),
        "<li>%d official repositories</li>" % len(github),
        "<li>%d official channel videos archived</li>" % len(videos),
        "<li>%d linked documents</li>" % len(documents),
        "<li>%d recorded failures or inaccessible items</li>" % failures,
        "<li>%d unresolved network requisites recorded</li>" % unresolved_count,
        "</ul><p>Video note: higher-resolution streams returned HTTP 403, so the complete fallback copies use YouTube format 18 (360p); previously retrieved higher-resolution files were retained.</p>"
        "<p><a href=\"manifest.json\">Collection manifest</a> · <a href=\"file_manifest.json\">Every file and checksum</a> · <a href=\"wayback_assets.json\">Historical asset provenance</a> · <a href=\"failure_records.json\">Failures</a> · <a href=\"unresolved_requisites.json\">Unresolved page requisites</a></p>"
        "<p>Scope: public Corellium sitemaps, historical blog URLs indexed by the Internet Archive, the official GitHub organization, the official YouTube channel, and cited primary sources. Authenticated, unindexed, and inaccessible material cannot be included.</p></section>",
    ]

    def page_list(title, records, wayback_mode=False):
        parts.append("<section><details><summary>%s (%d)</summary><ol>" % (html.escape(title), len(records)))
        for record in sorted(records, key=lambda x: (x.get("title") or x.get("source_url") or "").lower()):
            label = html.escape(record.get("title") or record.get("source_url") or "Unknown")
            if record.get("error"):
                parts.append("<li>%s — unavailable: %s</li>" % (label, html.escape(record["error"])))
                continue
            mirror = record.get("mirror_path") or current_mirror_for(record)
            raw = record.get("raw_path")
            links = []
            if mirror:
                links.append('<a href="%s">offline original</a>' % rel_href(mirror))
            if raw:
                links.append('<a href="%s">raw response</a>' % rel_href(raw))
            if record.get("source_url"):
                links.append('<a href="%s">source URL</a>' % html.escape(record["source_url"], quote=True))
            parts.append("<li>%s — %s</li>" % (label, " · ".join(links)))
        parts.append("</ol></details></section>")

    page_list("Current website, support center, API, and cited primary sources", current)
    page_list("Historical Corellium blog", wayback, True)

    parts.append("<section><details><summary>Official GitHub repositories (%d)</summary><ol>" % len(github))
    for repo in sorted(github, key=lambda x: x.get("name", "").lower()):
        links = []
        if repo.get("archive_path"):
            links.append('<a href="%s">source snapshot</a>' % rel_href(repo["archive_path"]))
        if repo.get("readme_path"):
            links.append('<a href="%s">README</a>' % rel_href(repo["readme_path"]))
        links.append('<a href="%s">source URL</a>' % html.escape(repo.get("source_url", ""), quote=True))
        parts.append("<li><code>%s</code> — %s</li>" % (html.escape(repo.get("name", "")), " · ".join(links)))
    parts.append("</ol></details></section>")

    parts.append("<section><details><summary>Official videos (%d)</summary><ol>" % len(videos))
    for info_path in videos:
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        folder = info_path.parent
        media_files = [p for p in folder.iterdir() if p.suffix.lower() in (".mp4", ".mkv", ".webm") and ".partial-download." not in p.name]
        link = rel_href(str(media_files[0].relative_to(ROOT))) if media_files else rel_href(str(info_path.relative_to(ROOT)))
        parts.append('<li><a href="%s">%s</a></li>' % (link, html.escape(info.get("title") or info.get("id") or info_path.stem)))
    parts.append("</ol></details></section>")

    parts.append("<section><details><summary>Linked documents (%d)</summary><ol>" % len(documents))
    for item in documents:
        label = html.escape(Path(urllib.parse.urlsplit(item.get("source_url", "")).path).name or item.get("source_url", ""))
        if item.get("path"):
            parts.append('<li><a href="%s">%s</a> — <a href="%s">source URL</a></li>' % (rel_href(item["path"]), label, html.escape(item["source_url"], quote=True)))
        else:
            parts.append("<li>%s — unavailable</li>" % label)
    parts.append("</ol></details></section>")
    parts.append('<footer><a href="#top">Top</a></footer></body></html>')
    (ROOT / "index.html").write_text("\n".join(parts), encoding="utf-8")
    manifest = {
        "generated_at": NOW(),
        "discovery": discovery,
        "current_pages": current,
        "historical_blog": wayback,
        "historical_assets": "wayback_assets.json",
        "github": github,
        "documents": documents,
        "videos": media_records,
        "channel_metadata": [str(path.relative_to(ROOT)) for path in channel_metadata],
        "media_capture_note": "Higher-resolution YouTube streams returned HTTP 403. Complete fallback copies were retrieved with Android-client format 18 (360p); any previously retrieved higher-resolution files were retained.",
        "failures": failure_records,
    }
    write_json(ROOT / "manifest.json", manifest)
    write_json(ROOT / "media_records.json", media_records)
    write_json(ROOT / "failure_records.json", failure_records)
    file_records = []
    for path in sorted(p for p in ROOT.rglob("*") if p.is_file() and p.name != "file_manifest.json"):
        stat = path.stat()
        file_records.append({
            "path": str(path.relative_to(ROOT)),
            "bytes": stat.st_size,
            "modified_at": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat(),
            "sha256": sha256_file(path),
        })
    write_json(ROOT / "file_manifest.json", {"generated_at": NOW(), "files": file_records})
    print("index built", ROOT / "index.html")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["discover", "current", "wayback", "github", "media", "documents", "index", "all"])
    args = parser.parse_args()
    phases = ["discover", "current", "wayback", "github", "media", "documents", "index"] if args.phase == "all" else [args.phase]
    actions = {
        "discover": discover,
        "current": mirror_current,
        "wayback": mirror_wayback,
        "github": archive_github,
        "media": archive_media,
        "documents": archive_documents,
        "index": build_index,
    }
    for phase in phases:
        print("==", phase, "==")
        actions[phase]()


if __name__ == "__main__":
    main()
