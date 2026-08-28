#!/usr/bin/env node
import { loadConfig, requireConfig } from "./lib/config.mjs";
import { executeSql, sqlIdentifier } from "./lib/db.mjs";
import { run } from "./lib/cli.mjs";

const config = loadConfig();
requireConfig(config, ["founderPrincipals", "cloudSqlDatabase"]);
const activeAccount = run("gcloud", ["config", "get-value", "account"], { capture: true }).trim();
const activePrincipal = activeAccount.endsWith(".gserviceaccount.com") ? `serviceAccount:${activeAccount}` : `user:${activeAccount}`;
const principals = [...new Set([activePrincipal, ...config.founderPrincipals.split(",").map((value) => value.trim()).filter(Boolean)])];
for (const principal of principals) {
  const [kind, identity] = principal.split(/:(.*)/s, 2);
  if (!new Set(["user", "serviceAccount"]).has(kind) || !identity) throw new Error(`Unsupported founder principal: ${principal}`);
  const databaseUser = kind === "serviceAccount" ? identity.replace(/\.gserviceaccount\.com$/, "") : identity;
  const role = sqlIdentifier(databaseUser);
  await executeSql(`
    GRANT CONNECT ON DATABASE ${sqlIdentifier(config.cloudSqlDatabase)} TO ${role};
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role};
  `, { application: "portomatic_grants", bootstrap: true });
  console.log(`Granted customer-call database access to ${principal}`);
}
