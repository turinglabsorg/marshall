import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const control = await resolveControlAddr(args.control ?? process.env.MARSHALL_CONTROL_ADDR, args["control-url"] ?? process.env.MARSHALL_CONTROL_URL);
const workerIdBase = requiredArg("worker-id-base", args["worker-id-base"] ?? process.env.MARSHALL_WORKER_ID_BASE);
const stateDir = requiredArg("state-dir", args["state-dir"] ?? process.env.MARSHALL_WORKER_STATE_DIR);
const modelConcurrency = modelConcurrencyArg();
const memoryGb = positiveNumberArg(requiredArg("memory-gb", args["memory-gb"] ?? process.env.MARSHALL_MEMORY_GB));
const slotMemoryGb = optionalPositiveNumberArg(args["slot-memory-gb"] ?? process.env.MARSHALL_WORKER_SLOT_MEMORY_GB);
const heartbeatIntervalMs = positiveIntegerArg(args["heartbeat-interval-ms"] ?? process.env.MARSHALL_HEARTBEAT_INTERVAL_MS ?? "15000");
const idleBackoffMs = positiveIntegerArg(args["idle-backoff-ms"] ?? process.env.MARSHALL_WORKER_POOL_IDLE_BACKOFF_MS ?? "5000");
const restartDelayMs = positiveIntegerArg(args["restart-delay-ms"] ?? process.env.MARSHALL_WORKER_RESTART_DELAY_MS ?? "5000");
const python = args.python ?? process.env.MARSHALL_PYTHON;
const workerScript = args["worker-script"] ?? siblingScript("worker-pool-cli");
const runOnce = booleanArg(args.once ?? process.env.MARSHALL_WORKER_SUPERVISOR_ONCE, false);

if (modelConcurrency < 1) {
  throw new Error("--model-concurrency must be greater than zero");
}
if (python == null || python === "") {
  throw new Error("--python or MARSHALL_PYTHON is required for model workers");
}

await mkdir(stateDir, { recursive: true });

const roles: WorkerRole[] = [
  {
    name: "model",
    jobTypes: ["train_adapter", "evaluate_adapter", "validate_artifact"],
    backend: "mlx",
    concurrency: modelConcurrency,
    needsPython: true,
  },
];

console.log(JSON.stringify({
  type: "marshall_worker_supervisor_started",
  control,
  worker_id_base: workerIdBase,
  state_dir: stateDir,
  memory_gb: memoryGb,
  slot_memory_gb: slotMemoryGb ?? null,
  roles: roles.map((role) => ({
    name: role.name,
    job_types: role.jobTypes,
    backend: role.backend,
    concurrency: role.concurrency,
  })),
}, null, 2));

if (runOnce) {
  const exitCodes = await Promise.all(roles.map((role) => runRole(role)));
  if (exitCodes.some((exitCode) => exitCode !== 0)) {
    process.exitCode = 1;
  }
} else {
  await Promise.all(roles.map((role) => superviseRole(role)));
}

interface WorkerRole {
  name: "model";
  jobTypes: Array<"train_adapter" | "evaluate_adapter" | "validate_artifact">;
  backend: "mlx";
  concurrency: number;
  needsPython: boolean;
}

async function superviseRole(role: WorkerRole): Promise<void> {
  while (true) {
    const exitCode = await runRole(role);
    console.error(`[${role.name}] worker pool exited with ${exitCode}; restarting in ${restartDelayMs}ms`);
    await sleep(restartDelayMs);
  }
}

async function runRole(role: WorkerRole): Promise<number | null> {
  const roleDir = join(stateDir, role.name);
  await mkdir(roleDir, { recursive: true });
  const values = [
    workerScript,
    "--control", control,
    "--job-types", role.jobTypes.join(","),
    "--backend", role.backend,
    "--concurrency", String(role.concurrency),
    "--worker-id-prefix", `${workerIdBase}-marshall-${role.name}`,
    "--key-dir", join(roleDir, "keys"),
    "--artifacts-dir", join(roleDir, "artifacts"),
    "--input-artifacts-dir", join(roleDir, "input-artifacts"),
    "--dataset-cache-dir", join(roleDir, "dataset-cache"),
    "--memory-gb", String(memoryGb),
    "--heartbeat-interval-ms", String(heartbeatIntervalMs),
    "--idle-backoff-ms", String(idleBackoffMs),
  ];
  if (slotMemoryGb != null) {
    values.push("--slot-memory-gb", String(slotMemoryGb));
  }
  if (role.needsPython) {
    values.push("--python", python!);
  }
  return runProcess(scriptCommand(workerScript), scriptArgs(workerScript, values), role.name);
}

function runProcess(command: string, values: string[], label: string): Promise<number | null> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, values, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(prefixLines(label, chunk.toString("utf8")));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(prefixLines(label, chunk.toString("utf8")));
    });
    child.on("close", (exitCode) => {
      resolveProcess(exitCode);
    });
  });
}

function prefixLines(label: string, text: string): string {
  return text.split(/(?<=\n)/).map((line) => line === "" ? line : `[${label}] ${line}`).join("");
}

async function resolveControlAddr(control: string | undefined, controlUrl: string | undefined): Promise<string> {
  if (control != null && control !== "") {
    return control;
  }
  const url = requiredArg("control-url", controlUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch control url ${url}: ${response.status}`);
  }
  const payload = await response.json() as { control_addr?: string };
  return requiredArg("control_addr", payload.control_addr);
}

function scriptCommand(scriptPath: string): string {
  if (scriptPath.endsWith(".ts")) {
    return resolve("node_modules/.bin/tsx");
  }
  return process.execPath;
}

function scriptArgs(scriptPath: string, values: string[]): string[] {
  return scriptPath.endsWith(".ts") ? values : values;
}

function siblingScript(baseName: string): string {
  const jsPath = fileURLToPath(new URL(`./${baseName}.js`, import.meta.url));
  if (existsSync(jsPath)) {
    return jsPath;
  }
  return jsPath.replace(/\.js$/, ".ts");
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next == null || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredArg(name: string, value: string | undefined): string {
  if (value == null || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requiredNonNegativeInteger(name: string, value: string | undefined): number {
  return nonNegativeIntegerArg(requiredArg(name, value));
}

function nonNegativeIntegerArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid non-negative integer: ${value}`);
  }
  return parsed;
}

function positiveIntegerArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function positiveNumberArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid positive number: ${value}`);
  }
  return parsed;
}

function optionalPositiveNumberArg(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  return positiveNumberArg(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function modelConcurrencyArg(): number {
  const explicit = args["model-concurrency"] ?? process.env.MARSHALL_MODEL_CONCURRENCY;
  if (explicit != null) {
    return requiredNonNegativeInteger("model-concurrency", explicit);
  }

  const legacyValues = [
    args["train-concurrency"] ?? process.env.MARSHALL_TRAIN_CONCURRENCY,
    args["eval-concurrency"] ?? process.env.MARSHALL_EVAL_CONCURRENCY,
    args["validation-concurrency"] ?? process.env.MARSHALL_VALIDATION_CONCURRENCY,
  ].filter((value): value is string => value != null);

  if (legacyValues.length > 0) {
    return Math.max(...legacyValues.map(nonNegativeIntegerArg));
  }

  throw new Error("--model-concurrency or MARSHALL_MODEL_CONCURRENCY is required");
}

function booleanArg(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new Error(`invalid boolean: ${value}`);
}
