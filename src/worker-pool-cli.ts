import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const control = args.control ?? process.env.MARSHALL_CONTROL_ADDR;
const controlNetworkPath = args["control-network-path"] ?? process.env.MARSHALL_CONTROL_NETWORK_PATH;
const controlNetworkUrl = args["control-network-url"] ?? process.env.MARSHALL_CONTROL_NETWORK_URL;
const jobTypes = jobTypesArg(args["job-types"] ?? process.env.MARSHALL_JOB_TYPES ?? args["job-type"] ?? process.env.MARSHALL_JOB_TYPE);

if ((control == null || control === "") && (controlNetworkPath == null || controlNetworkPath === "") && (controlNetworkUrl == null || controlNetworkUrl === "")) {
  throw new Error("--control, MARSHALL_CONTROL_ADDR, or control network source is required");
}

const requestedConcurrency = numberArg(args.concurrency ?? process.env.MARSHALL_WORKER_POOL_CONCURRENCY, 1);
const maxJobs = optionalNumberArg(args["max-jobs"] ?? process.env.MARSHALL_WORKER_POOL_MAX_JOBS);
const idleBackoffMs = numberArg(args["idle-backoff-ms"] ?? process.env.MARSHALL_WORKER_POOL_IDLE_BACKOFF_MS, 5_000);
const exitWhenIdle = booleanArg(args["exit-when-idle"] ?? process.env.MARSHALL_WORKER_POOL_EXIT_WHEN_IDLE, false);
const workerPrefix = args["worker-id-prefix"] ?? process.env.MARSHALL_WORKER_ID_PREFIX ?? "marshall-worker";
const keyDir = args["key-dir"] ?? process.env.MARSHALL_WORKER_KEY_DIR ?? ".marshall/worker-pool-keys";
const workerScript = args["worker-script"] ?? siblingScript("worker-cli");
const memoryGb = optionalPositiveNumberArg(args["memory-gb"] ?? process.env.MARSHALL_MEMORY_GB);
const slotMemoryGb = optionalPositiveNumberArg(args["slot-memory-gb"] ?? process.env.MARSHALL_WORKER_SLOT_MEMORY_GB);
const concurrency = effectiveConcurrency(requestedConcurrency, memoryGb, slotMemoryGb);
const workerMemoryGb = slotMemoryGb ?? memoryGb;

await mkdir(keyDir, { recursive: true });

let reserved = 0;
let completed = 0;
let failed = 0;
let idleClaims = 0;
let stopping = false;

await Promise.all(Array.from({ length: concurrency }, (_value, index) => runSlot(index + 1)));

console.log(JSON.stringify({
  type: "marshall_worker_pool_completed",
  job_type: jobTypes.join(","),
  job_types: jobTypes,
  control,
  concurrency,
  requested_concurrency: requestedConcurrency,
  memory_gb: memoryGb ?? null,
  slot_memory_gb: slotMemoryGb ?? null,
  max_jobs: maxJobs ?? null,
  completed,
  failed,
  idle_claims: idleClaims,
  persistent: maxJobs == null,
}, null, 2));

async function runSlot(slot: number): Promise<void> {
  while (!stopping) {
    if (!reserveRun()) {
      return;
    }
    const result = await runWorker(slot);
    if (result === "completed") {
      completed += 1;
      continue;
    }
    if (result === "idle") {
      releaseReservedRun();
      idleClaims += 1;
      if (exitWhenIdle) {
        stopping = true;
        return;
      }
      await sleep(idleBackoffMs);
      continue;
    }
    failed += 1;
    await sleep(idleBackoffMs);
  }
}

function reserveRun(): boolean {
  if (maxJobs != null && reserved >= maxJobs) {
    return false;
  }
  reserved += 1;
  return true;
}

function releaseReservedRun(): void {
  reserved = Math.max(0, reserved - 1);
}

async function runWorker(slot: number): Promise<"completed" | "failed" | "idle"> {
  const suffix = String(slot).padStart(4, "0");
  const workerArgs = [
    workerScript,
    "--job-types",
    jobTypes.join(","),
    "--backend",
    args.backend ?? process.env.MARSHALL_BACKEND ?? "mlx",
    "--worker-id",
    `${workerPrefix}-${suffix}`,
    "--key",
    resolve(keyDir, `${workerPrefix}-${suffix}.key`),
    ...passThroughArgs(args),
    ...optionalValueArg("--memory-gb", workerMemoryGb),
  ];
  if (control != null && control !== "") {
    workerArgs.splice(1, 0, "--control", control);
  }

  await mkdir(dirname(resolve(keyDir, `${workerPrefix}-${suffix}.key`)), { recursive: true });
  const result = await runProcess(scriptCommand(workerScript), scriptArgs(workerScript, workerArgs));
  if (result.exitCode !== 0) {
    if (isNoJobAssigned(result)) {
      return "idle";
    }
    process.stderr.write(result.stderr || result.stdout || `worker ${suffix} exited ${result.exitCode}\n`);
    return "failed";
  }
  return "completed";
}

function passThroughArgs(values: Record<string, string>): string[] {
  const keys = [
    "artifacts-dir",
    "input-artifacts-dir",
    "dataset-cache-dir",
    "python",
    "model",
    "iters",
    "batch-size",
    "learning-rate",
    "num-layers",
    "max-seq-length",
    "steps-per-report",
    "steps-per-eval",
    "val-batches",
    "seed",
    "mask-prompt",
    "no-mask-prompt",
    "grad-checkpoint",
    "tokens-per-second",
    "swarm-token",
    "job-lease-seconds",
    "heartbeat-interval-ms",
    "idle-backoff-ms",
    "artifact-chunk-bytes",
    "artifact-chunk-retries",
    "control-addrs",
    "control-network-path",
    "control-network-url",
  ];
  const output: string[] = [];
  for (const key of keys) {
    if (values[key] != null) {
      output.push(`--${key}`, values[key]);
    }
  }
  return output;
}

function runProcess(command: string, values: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, values, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      resolveProcess({ stdout, stderr, exitCode });
    });
  });
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

function isNoJobAssigned(result: { stdout: string; stderr: string }): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return output.includes("no job assigned");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jobTypesArg(value: string | undefined): string[] {
  if (value == null || value.trim() === "") {
    throw new Error("--job-types or MARSHALL_JOB_TYPES is required");
  }
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error("--job-types must include at least one job type");
  }
  return [...new Set(values)];
}

function effectiveConcurrency(requested: number, totalMemoryGb: number | undefined, perSlotMemoryGb: number | undefined): number {
  if (totalMemoryGb == null || perSlotMemoryGb == null) {
    return requested;
  }
  return Math.max(1, Math.min(requested, Math.floor(totalMemoryGb / perSlotMemoryGb)));
}

function optionalValueArg(flag: string, value: number | string | undefined): string[] {
  if (value == null) {
    return [];
  }
  return [flag, String(value)];
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value == null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function optionalNumberArg(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  return numberArg(value, 1);
}

function optionalPositiveNumberArg(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid positive number: ${value}`);
  }
  return parsed;
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
