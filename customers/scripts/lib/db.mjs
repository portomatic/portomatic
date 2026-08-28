import { loadConfig, requireConfig } from "./config.mjs";
import { run } from "./cli.mjs";

export async function executeSql(sql, options = {}) {
  const config = loadConfig();
  requireConfig(config, ["projectId", "cloudSqlInstance", "cloudSqlDatabase"]);
  if (options.bootstrap) requireConfig(config, ["cloudSqlBootstrapSecretVersion"]);
  const token = run("gcloud", ["auth", "print-access-token"], { capture: true }).trim();
  if (!token) throw new Error("gcloud did not return an access token");
  const endpoint = new URL(
    `https://sqladmin.googleapis.com/sql/v1beta4/projects/${encodeURIComponent(config.projectId)}/instances/${encodeURIComponent(config.cloudSqlInstance)}/executeSql`,
  );
  endpoint.searchParams.set("location", config.location);
  const response = await fetch(endpoint, {
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
  });
  const payload = await response.json();
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
