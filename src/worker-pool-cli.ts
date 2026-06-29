import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const control = args.control ?? process.env.MARSHALL_CONTROL_ADDR;
const jobType = args["job-type"] ?? process.env.MARSHALL_JOB_TYPE;

if (control == null) {
  throw new Error("--control or MARSHALL_CONTROL_ADDR is required");
}
if (jobType == null) {
  throw new Error("--job-type or MARSHALL_JOB_TYPE is required");
}

const concurrency = numberArg(args.concurrency ?? process.env.MARSHALL_WORKER_POOL_CONCURRENCY, 1);
const maxJobs = numberArg(args["max-jobs"] ?? process.env.MARSHALL_WORKER_POOL_MAX_JOBS, 1);
const workerPrefix = args["worker-id-prefix"] ?? process.env.MARSHALL_WORKER_ID_PREFIX ?? "marshall-worker";
const keyDir = args["key-dir"] ?? process.env.MARSHALL_WORKER_KEY_DIR ?? ".marshall/worker-pool-keys";
const workerScript = args["worker-script"] ?? fileURLToPath(new URL("./worker-cli.js", import.meta.url));

await mkdir(keyDir, { recursive: true });

let launched = 0;
let completed = 0;
let failed = 0;
let stopping = false;

const active = new Set<Promise<void>>();
while (!stopping && launched < maxJobs) {
  while (!stopping && active.size < concurrency && launched < maxJobs) {
    launched += 1;
    const promise = runWorker(launched)
      .catch((error) => {
        failed += 1;
        if (String(error?.message ?? error).includes("no job assigned")) {
          stopping = true;
          return;
        }
        throw error;
      })
      .finally(() => {
        active.delete(promise);
      });
    active.add(promise);
  }
  if (active.size > 0) {
    await Promise.race(active);
  }
}
await Promise.allSettled(active);

console.log(JSON.stringify({
  type: "marshall_worker_pool_completed",
  job_type: jobType,
  control,
  concurrency,
  max_jobs: maxJobs,
  launched,
  completed,
  failed,
}, null, 2));

async function runWorker(index: number): Promise<void> {
  const suffix = String(index).padStart(4, "0");
  const workerArgs = [
    workerScript,
    "--control",
    control!,
    "--job-type",
    jobType!,
    "--backend",
    args.backend ?? process.env.MARSHALL_BACKEND ?? "mlx",
    "--worker-id",
    `${workerPrefix}-${suffix}`,
    "--key",
    resolve(keyDir, `${workerPrefix}-${suffix}.key`),
    ...passThroughArgs(args),
  ];

  await mkdir(dirname(resolve(keyDir, `${workerPrefix}-${suffix}.key`)), { recursive: true });
  const result = await runProcess(process.execPath, workerArgs);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `worker ${suffix} exited ${result.exitCode}`);
  }
  completed += 1;
}

function passThroughArgs(values: Record<string, string>): string[] {
  const keys = [
    "artifacts-dir",
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
    "memory-gb",
    "tokens-per-second",
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
