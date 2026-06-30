import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const control = await resolveControlAddr(args.control ?? process.env.MARSHALL_CONTROL_ADDR, args["control-url"] ?? process.env.MARSHALL_CONTROL_URL);
const workerIdBase = requiredArg("worker-id-base", args["worker-id-base"] ?? process.env.MARSHALL_WORKER_ID_BASE);
const stateDir = requiredArg("state-dir", args["state-dir"] ?? process.env.MARSHALL_WORKER_STATE_DIR);
const trainConcurrency = requiredNonNegativeInteger("train-concurrency", args["train-concurrency"] ?? process.env.MARSHALL_TRAIN_CONCURRENCY);
const evalConcurrency = requiredNonNegativeInteger("eval-concurrency", args["eval-concurrency"] ?? process.env.MARSHALL_EVAL_CONCURRENCY);
const validationConcurrency = requiredNonNegativeInteger("validation-concurrency", args["validation-concurrency"] ?? process.env.MARSHALL_VALIDATION_CONCURRENCY);
const heartbeatIntervalMs = positiveIntegerArg(args["heartbeat-interval-ms"] ?? process.env.MARSHALL_HEARTBEAT_INTERVAL_MS ?? "15000");
const idleBackoffMs = positiveIntegerArg(args["idle-backoff-ms"] ?? process.env.MARSHALL_WORKER_POOL_IDLE_BACKOFF_MS ?? "5000");
const restartDelayMs = positiveIntegerArg(args["restart-delay-ms"] ?? process.env.MARSHALL_WORKER_RESTART_DELAY_MS ?? "5000");
const python = args.python ?? process.env.MARSHALL_PYTHON;
const workerScript = args["worker-script"] ?? siblingScript("worker-pool-cli");

if (trainConcurrency + evalConcurrency + validationConcurrency < 1) {
  throw new Error("at least one worker role concurrency must be greater than zero");
}
if ((trainConcurrency > 0 || evalConcurrency > 0) && (python == null || python === "")) {
  throw new Error("--python or MARSHALL_PYTHON is required when train/eval concurrency is greater than zero");
}

await mkdir(stateDir, { recursive: true });

const configuredRoles: WorkerRole[] = [
  {
    name: "train",
    jobType: "train_adapter",
    backend: "mlx",
    concurrency: trainConcurrency,
    needsPython: true,
  },
  {
    name: "eval",
    jobType: "evaluate_adapter",
    backend: "mlx",
    concurrency: evalConcurrency,
    needsPython: true,
  },
  {
    name: "validate",
    jobType: "validate_artifact",
    backend: "cpu",
    concurrency: validationConcurrency,
    needsPython: false,
  },
];
const roles = configuredRoles.filter((role) => role.concurrency > 0);

console.log(JSON.stringify({
  type: "marshall_worker_supervisor_started",
  control,
  worker_id_base: workerIdBase,
  state_dir: stateDir,
  roles: roles.map((role) => ({
    name: role.name,
    job_type: role.jobType,
    backend: role.backend,
    concurrency: role.concurrency,
  })),
}, null, 2));

await Promise.all(roles.map((role) => superviseRole(role)));

interface WorkerRole {
  name: "train" | "eval" | "validate";
  jobType: "train_adapter" | "evaluate_adapter" | "validate_artifact";
  backend: "mlx" | "cpu";
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
    "--job-type", role.jobType,
    "--backend", role.backend,
    "--concurrency", String(role.concurrency),
    "--worker-id-prefix", `${workerIdBase}-marshall-${role.name}`,
    "--key-dir", join(roleDir, "keys"),
    "--artifacts-dir", join(roleDir, "artifacts"),
    "--input-artifacts-dir", join(roleDir, "input-artifacts"),
    "--dataset-cache-dir", join(roleDir, "dataset-cache"),
    "--heartbeat-interval-ms", String(heartbeatIntervalMs),
    "--idle-backoff-ms", String(idleBackoffMs),
  ];
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}
