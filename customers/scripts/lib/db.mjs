import { loadConfig, requireConfig } from "./config.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
let tokenRequest = null, cachedToken = null, tokenExpires = 0;
async function accessToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;
  if (!tokenRequest) tokenRequest = exec("gcloud", ["auth", "print-access-token"], { timeout: 30000, maxBuffer: 1024 * 1024 })
    .then(({stdout}) => {
      const token = stdout.trim();
      if (!token) throw new Error("gcloud did not return an access token");
      cachedToken = token; tokenExpires = Date.now() + 45000; return token;
    }).finally(() => { tokenRequest = null; });
  return await tokenRequest;
}

export async function executeSql(sql, options = {}) {
  const config = loadConfig();
  requireConfig(config, ["projectId", "cloudSqlInstance", "cloudSqlDatabase"]);
  if (options.bootstrap) requireConfig(config, ["cloudSqlBootstrapSecretVersion"]);
  const token = await accessToken();
  const endpoint = new URL(
    `https://sqladmin.googleapis.com/sql/v1beta4/projects/${encodeURIComponent(config.projectId)}/instances/${encodeURIComponent(config.cloudSqlInstance)}/executeSql`,
  );
  endpoint.searchParams.set("location", config.location);
  const request = {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      database: config.cloudSqlDatabase,
      ...(options.bootstrap ? {
        user: "postgres",
        passwordSecretVersion: config.cloudSqlBootstrapSecretVersion,
      } : { autoIamAuthn: true }),
      application: options.application || "portomatic_ops",
      rowLimit: String(options.rowLimit ?? 10000),
      partialResultMode: "FAIL_PARTIAL_RESULT",
      sqlStatement: sql,
    }),
  };
  let response;
  // A quota rejection happens before SQL execution, so retrying this response is safe for writes.
  for (let attempt = 0; attempt < 6; attempt++) {
    response = await fetch(endpoint, request);
    if (response.status !== 429 || attempt === 5) break;
    await response.arrayBuffer();
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, retryAfter || 1000 * 2 ** attempt) + Math.random() * 500));
  }
  const payload = await response.json();
  if (response.status === 401) { cachedToken = null; tokenExpires = 0; }
  if (!response.ok) throw new Error(`Cloud SQL Data API failed (${response.status}): ${formatApiError(payload)}`);
  if (payload.status?.code) throw new Error(`Cloud SQL rejected the query: ${formatApiError(payload.status)}`);
  for (const result of payload.results || []) {
    if (result.status?.code) throw new Error(`Cloud SQL query failed: ${formatApiError(result.status)}`);
    if (result.partialResult) throw new Error("Cloud SQL returned a partial result");
  }
  return payload;
}

export async function queryRows(sql, options = {}) {
  const payload = await executeSql(sql, options);
  const result = [...(payload.results || [])].reverse().find((item) => item.columns?.length) || { columns: [], rows: [] };
  const names = result.columns.map((column) => column.name);
  return (result.rows || []).map((row) => Object.fromEntries(names.map((name, index) => [name, readValue(row.values?.[index])])))
}

export function sqlLiteral(value) {
  if (value == null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialize non-finite number: ${value}`);
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function sqlValues(rows) {
  return rows.map((row) => `(${row.map(sqlLiteral).join(", ")})`).join(",\n");
}

function readValue(item) {
  if (!item || item.nullValue) return null;
  return item.value ?? null;
}

function formatApiError(value) {
  return value?.message || value?.error?.message || JSON.stringify(value);
}
