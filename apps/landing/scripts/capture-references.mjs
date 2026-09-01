import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const references = [
  ["greptile", "https://www.greptile.com/"],
  ["namespace", "https://namespace.so/"],
  ["cognition", "https://cognition.ai/"],
  ["openai", "https://openai.com/"],
  ["databricks", "https://www.databricks.com/"],
  ["ploy", "https://ploy.ai/"],
  ["cursor", "https://cursor.com/"],
  ["arcade", "https://www.arcade.dev/"],
  ["daytona", "https://www.daytona.io/"],
  ["composio", "https://composio.dev/"],
  ["nango", "https://nango.dev/"],
  ["resend", "https://resend.com/"],
  ["inkeep", "https://inkeep.com/"],
  ["morph", "https://www.morphllm.com/"],
  ["smolmachines", "https://smolmachines.com/"],
];

const scriptsRoot = fileURLToPath(new URL("./", import.meta.url));
const landingRoot = fileURLToPath(new URL("../", import.meta.url));
const capturesRoot = join(landingRoot, "captures");
const requested = process.argv.slice(2);

if (requested.includes("--list")) {
  console.log(references.map(([slug]) => slug).join("\n"));
  process.exit(0);
}

const selected = requested.length
  ? references.filter(([slug]) => requested.includes(slug))
  : references;
const known = new Set(references.map(([slug]) => slug));
const unknown = requested.filter((slug) => !known.has(slug));

if (unknown.length) {
  console.error(`Unknown reference${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  console.error(`Available references: ${[...known].join(", ")}`);
  process.exit(1);
}

async function run(script, args) {
  const child = spawn(process.execPath, [join(scriptsRoot, script), ...args], {
    env: process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error(`${script} exited with status ${exitCode ?? "unknown"}`);
}

async function installCapture(temporaryOutput, output) {
  const previousOutput = `${output}.previous-${process.pid}`;
  let movedPrevious = false;
  try {
    await rename(output, previousOutput);
    movedPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  try {
    await rename(temporaryOutput, output);
  } catch (error) {
    if (movedPrevious) await rename(previousOutput, output);
    throw error;
  }
  if (movedPrevious) {
    await rm(previousOutput, { recursive: true, force: true }).catch((error) => {
      console.warn(`Could not remove previous ${output} capture: ${error.message}`);
    });
  }
}

await mkdir(capturesRoot, { recursive: true });

for (const [slug, url] of selected) {
  const output = join(capturesRoot, slug);
  const temporaryOutput = join(capturesRoot, `.${slug}-${process.pid}-${Date.now()}`);
  console.log(`\nCapturing ${slug} from ${url}`);
  try {
    await run("capture-site.mjs", [
      `--slug=${slug}`,
      `--url=${url}`,
      `--output=${temporaryOutput}`,
    ]);
    await run("localize-capture.mjs", [temporaryOutput]);
    await run("recover-static-assets.mjs", [temporaryOutput]);
    await run("localize-capture.mjs", [temporaryOutput]);
    await installCapture(temporaryOutput, output);
  } catch (error) {
    await rm(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

console.log(`\nCaptured ${selected.length} reference${selected.length === 1 ? "" : "s"}.`);
