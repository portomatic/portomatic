import { spawnSync } from "node:child_process";

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (inlineValue !== undefined) {
      result[rawName] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      result[rawName] = argv[index + 1];
      index += 1;
    } else {
      result[rawName] = true;
    }
  }
  return result;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return options.capture ? result.stdout : "";
}

export function requireArgs(args, names) {
  const missing = names.filter((name) => !args[name]);
  if (missing.length > 0) throw new Error(`Missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`);
}
