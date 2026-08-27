import { formatTimestamp } from "./time.mjs";

export function buildViewerHtml({ title, rows, signedByUri }) {
  const uniqueUris = [...signedByUri.keys()];
  const videoIds = new Map(uniqueUris.map((uri, index) => [uri, `recording-${index + 1}`]));
  const recordingsHtml = uniqueUris.map((uri, index) => {
    const item = signedByUri.get(uri);
    return `<section class="recording"><p>Recording ${index + 1}</p><video id="${videoIds.get(uri)}" controls preload="metadata" src="${escapeAttribute(item.signedUrl)}"></video></section>`;
  }).join("\n");
  const transcriptRows = rows
    .filter((row) => row.transcript || row.segment_start_seconds !== "")
    .sort((left, right) => Date.parse(left.recorded_at) - Date.parse(right.recorded_at) || Number(left.segment_start_seconds) - Number(right.segment_start_seconds))
    .map((row) => {
      const seconds = Number(row.segment_start_seconds || 0);
      const videoId = videoIds.get(row.recording_uri);
      const href = `${signedByUri.get(row.recording_uri).signedUrl}#t=${seconds}`;
      return `<tr><td><a class="seek" href="${escapeAttribute(href)}" data-video="${videoId}" data-seconds="${seconds}">${formatTimestamp(seconds)}</a></td><td>${escapeHtml(row.speaker || "—")}</td><td><a class="seek transcript" href="${escapeAttribute(href)}" data-video="${videoId}" data-seconds="${seconds}">${escapeHtml(row.transcript || "Transcript pending")}</a></td></tr>`;
    }).join("\n");
  const duration = signedByUri.values().next().value.duration;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>body{max-width:1080px;margin:40px auto;padding:0 24px;background:#f7f7f4;color:#171715;font:15px/1.5 system-ui,sans-serif}h1{font-size:28px;font-weight:600}video{width:100%;max-height:620px;background:#111}.recording{margin:28px 0}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:12px 14px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#666}.seek{color:#174ea6;text-underline-offset:3px}.transcript{color:inherit}aside{margin:20px 0;padding:12px 14px;background:#fff4ce;border:1px solid #e7cf78}</style></head>
<body><h1>${escapeHtml(title)}</h1><aside>This local page contains signed bearer URLs valid for ${escapeHtml(duration)}. Do not share it. Delete it when finished.</aside>${recordingsHtml}<table><thead><tr><th>Timestamp</th><th>Speaker</th><th>Transcript</th></tr></thead><tbody>${transcriptRows}</tbody></table>
<script>document.querySelectorAll('.seek').forEach((link)=>link.addEventListener('click',(event)=>{event.preventDefault();const video=document.getElementById(link.dataset.video);video.currentTime=Number(link.dataset.seconds);video.scrollIntoView({behavior:'smooth',block:'center'});video.play();}));</script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
