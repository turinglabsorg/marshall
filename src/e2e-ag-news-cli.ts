import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CoordinatorClient } from "./coordinator-client.js";
import { MarshallJobSchema, TrainingArtifactManifestSchema, type AdapterEvaluationJob, type ArtifactValidationJob } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const startedAt = timestamp();
const runId = args["run-id"] ?? process.env.MARSHALL_RUN_ID ?? `run_ag_news_e2e_${startedAt}`;
const jobPrefix = args["job-prefix"] ?? args["job-id"] ?? process.env.MARSHALL_JOB_ID ?? `job_ag_news_e2e_${startedAt}`;
const runRoot = args["run-root"] ?? process.env.MARSHALL_RUN_ROOT ?? join(".marshall", "runs", runId);
const datasetDir = args["dataset-dir"] ?? process.env.MARSHALL_ADAPTER_DATASET_DIR ?? ".marshall/datasets/ag-news";
const evalFile = args["eval-file"] ?? process.env.MARSHALL_EVAL_FILE ?? join(datasetDir, "eval.jsonl");
const coordinatorUrl = args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL;
const coordinatorToken = args["coordinator-token"] ?? process.env.MARSHALL_COORDINATOR_TOKEN;
const swarmToken = args["swarm-token"] ?? process.env.MARSHALL_SWARM_TOKEN;
const jobLeaseSeconds = args["job-lease-seconds"] ?? process.env.MARSHALL_JOB_LEASE_SECONDS;
const heartbeatIntervalMs = args["heartbeat-interval-ms"] ?? process.env.MARSHALL_HEARTBEAT_INTERVAL_MS;
const pythonBin = args.python ?? process.env.MARSHALL_PYTHON;
const jobCount = numberArg(args["job-count"] ?? process.env.MARSHALL_JOB_COUNT, 4);
const concurrency = numberArg(args.concurrency ?? process.env.MARSHALL_WORKER_POOL_CONCURRENCY, jobCount);
const requireValidation = booleanArg(args["require-validation"] ?? process.env.MARSHALL_REQUIRE_VALIDATION, coordinatorUrl != null && coordinatorUrl !== "");
const validationQuorum = numberArg(args["validation-quorum"] ?? process.env.MARSHALL_VALIDATION_QUORUM, 2);
const validatorsPerArtifact = numberArg(args["validators-per-artifact"] ?? process.env.MARSHALL_VALIDATORS_PER_ARTIFACT, validationQuorum);
const validationConcurrency = numberArg(args["validation-concurrency"] ?? process.env.MARSHALL_VALIDATION_CONCURRENCY, Math.max(1, Math.min(concurrency, validatorsPerArtifact * jobCount)));

if (requireValidation && (coordinatorUrl == null || coordinatorUrl === "")) {
  throw new Error("--require-validation requires --coordinator-url or MARSHALL_COORDINATOR_URL");
}
if (validatorsPerArtifact < validationQuorum) {
  throw new Error("--validators-per-artifact must be greater than or equal to --validation-quorum");
}

const artifactsDir = args["artifacts-dir"] ?? join(runRoot, "artifacts");
const evalJobsFile = args["eval-jobs-file"] ?? join(runRoot, "jobs", "evaluate-adapters.json");
const evalArtifactsDir = args["eval-artifacts-dir"] ?? join(runRoot, "eval-artifacts");
const validationJobsFile = args["validation-jobs-file"] ?? join(runRoot, "jobs", "validate-artifacts.json");
const validationArtifactsDir = args["validation-artifacts-dir"] ?? join(runRoot, "validation-artifacts");
const leaderboardDir = args["leaderboard-dir"] ?? join(runRoot, "leaderboard");
const modelPackageDir = args["model-package-dir"] ?? join(runRoot, "model-package");
const queryDir = args["query-dir"] ?? join(runRoot, "query");
const datasetCacheDir = args["dataset-cache-dir"] ?? join(runRoot, "cache", "datasets");
const evalDatasetCacheDir = args["eval-dataset-cache-dir"] ?? join(runRoot, "cache", "eval-datasets");

const controlScript = siblingScript("control-cli");
const workerScript = siblingScript("worker-cli");
const workerPoolScript = siblingScript("worker-pool-cli");
const evalJobsScript = siblingScript("evaluation-jobs-cli");
const validationJobsScript = siblingScript("validation-jobs-cli");
const leaderboardScript = siblingScript("leaderboard-cli");
const modelPackageScript = siblingScript("model-package-cli");
const modelQueryScript = siblingScript("model-query-cli");

await mkdir(runRoot, { recursive: true });

const trainControl = await startControl([
  "--listen", "/ip4/127.0.0.1/tcp/0",
  "--job-type", "train_adapter",
  "--job-count", String(jobCount),
  "--job-id", jobPrefix,
  "--run-id", runId,
  "--round-id", "round_001",
  "--adapter-dataset", "ag_news",
  "--adapter-dataset-dir", datasetDir,
  "--key", join(runRoot, "control-train.key"),
  ...optionalArg("--coordinator-url", coordinatorUrl),
  ...optionalArg("--coordinator-token", coordinatorToken),
  ...optionalArg("--swarm-token", swarmToken),
  ...optionalArg("--job-lease-seconds", jobLeaseSeconds),
]);
try {
  assertWorkerPoolResult("training", parseWorkerPoolResult(await runScript(workerPoolScript, [
    "--control", trainControl.addr,
    "--job-type", "train_adapter",
    "--backend", "mlx",
    "--concurrency", String(concurrency),
    "--max-jobs", String(jobCount),
    "--worker-id-prefix", `${runId}-train`,
    "--key-dir", join(runRoot, "worker-keys", "train"),
    "--worker-script", workerScript,
    "--artifacts-dir", artifactsDir,
    "--dataset-cache-dir", datasetCacheDir,
    ...optionalArg("--swarm-token", swarmToken),
    ...optionalArg("--job-lease-seconds", jobLeaseSeconds),
    ...optionalArg("--heartbeat-interval-ms", heartbeatIntervalMs),
    "--iters", args.iters ?? process.env.MARSHALL_ITERS ?? "20",
    "--batch-size", args["batch-size"] ?? process.env.MARSHALL_BATCH_SIZE ?? "1",
    "--num-layers", args["num-layers"] ?? process.env.MARSHALL_NUM_LAYERS ?? "2",
    "--max-seq-length", args["max-seq-length"] ?? process.env.MARSHALL_MAX_SEQ_LENGTH ?? "384",
    "--steps-per-report", args["steps-per-report"] ?? process.env.MARSHALL_STEPS_PER_REPORT ?? "5",
    "--steps-per-eval", args["steps-per-eval"] ?? process.env.MARSHALL_STEPS_PER_EVAL ?? "10",
    "--val-batches", args["val-batches"] ?? process.env.MARSHALL_VAL_BATCHES ?? "2",
    "--seed", args.seed ?? process.env.MARSHALL_SEED ?? "42",
    ...optionalArg("--python", pythonBin),
  ])), jobCount);
} finally {
  await stopControl(trainControl.child);
}

await runScript(evalJobsScript, [
  "--artifacts-dir", artifactsDir,
  "--adapter-job-prefix", jobPrefix,
  "--eval-file", evalFile,
  "--output", evalJobsFile,
  "--run-id", `${runId}_eval`,
  "--job-prefix", `${jobPrefix}_eval`,
  "--max-examples", args["eval-examples"] ?? process.env.MARSHALL_EVAL_EXAMPLES ?? "40",
  "--max-tokens", args["eval-max-tokens"] ?? process.env.MARSHALL_EVAL_MAX_TOKENS ?? "8",
]);
const evalJobs = parseEvalJobs(JSON.parse(await readFile(evalJobsFile, "utf8")));
if (evalJobs.length !== jobCount) {
  throw new Error(`evaluation job generation produced ${evalJobs.length}, expected ${jobCount}`);
}

const evalControl = await startControl([
  "--listen", "/ip4/127.0.0.1/tcp/0",
  "--job-type", "evaluate_adapter",
  "--jobs-file", evalJobsFile,
  "--key", join(runRoot, "control-eval.key"),
  ...optionalArg("--coordinator-url", coordinatorUrl),
  ...optionalArg("--coordinator-token", coordinatorToken),
  ...optionalArg("--swarm-token", swarmToken),
  ...optionalArg("--job-lease-seconds", jobLeaseSeconds),
]);
try {
  assertWorkerPoolResult("evaluation", parseWorkerPoolResult(await runScript(workerPoolScript, [
    "--control", evalControl.addr,
    "--job-type", "evaluate_adapter",
    "--backend", "mlx",
    "--concurrency", String(concurrency),
    "--max-jobs", String(jobCount),
    "--worker-id-prefix", `${runId}-eval`,
    "--key-dir", join(runRoot, "worker-keys", "eval"),
    "--worker-script", workerScript,
    "--artifacts-dir", evalArtifactsDir,
    "--dataset-cache-dir", evalDatasetCacheDir,
    ...optionalArg("--swarm-token", swarmToken),
    ...optionalArg("--job-lease-seconds", jobLeaseSeconds),
    ...optionalArg("--heartbeat-interval-ms", heartbeatIntervalMs),
    ...optionalArg("--python", pythonBin),
  ])), jobCount);
} finally {
  await stopControl(evalControl.child);
}

let validationJobs: ArtifactValidationJob[] = [];
if (requireValidation) {
  await runScript(validationJobsScript, [
    "--coordinator-url", coordinatorUrl!,
    "--output", validationJobsFile,
    "--run-id", `${runId}_validation`,
    "--job-prefix", `${jobPrefix}_validate`,
    "--target-artifact-type", "adapter_evaluation",
    "--target-job-prefix", `${jobPrefix}_eval`,
    "--quorum", String(validationQuorum),
    "--validators-per-artifact", String(validatorsPerArtifact),
    "--min-accuracy", args["validation-min-accuracy"] ?? process.env.MARSHALL_VALIDATION_MIN_ACCURACY ?? "0.3",
    "--max-invalid-rate", args["validation-max-invalid-rate"] ?? process.env.MARSHALL_VALIDATION_MAX_INVALID_RATE ?? "0.2",
    "--min-examples", args["validation-min-examples"] ?? process.env.MARSHALL_VALIDATION_MIN_EXAMPLES ?? "1",
    ...optionalArg("--coordinator-token", coordinatorToken),
  ]);
  validationJobs = parseValidationJobs(JSON.parse(await readFile(validationJobsFile, "utf8")));
  const expectedValidationJobs = jobCount * validatorsPerArtifact;
  if (validationJobs.length !== expectedValidationJobs) {
    throw new Error(`validation job generation produced ${validationJobs.length}, expected ${expectedValidationJobs}`);
  }

  const validationControl = await startControl([
    "--listen", "/ip4/127.0.0.1/tcp/0",
    "--job-type", "validate_artifact",
    "--jobs-file", validationJobsFile,
    "--key", join(runRoot, "control-validation.key"),
    ...optionalArg("--coordinator-url", coordinatorUrl),
    ...optionalArg("--coordinator-token", coordinatorToken),
    ...optionalArg("--swarm-token", swarmToken),
    ...optionalArg("--job-lease-seconds", jobLeaseSeconds),
  ]);
  try {
    assertWorkerPoolResult("validation", parseWorkerPoolResult(await runScript(workerPoolScript, [
      "--control", validationControl.addr,
      "--job-type", "validate_artifact",
      "--backend", "cpu",
      "--concurrency", String(validationConcurrency),
      "--max-jobs", String(validationJobs.length),
      "--worker-id-prefix", `${runId}-validator`,
      "--key-dir", join(runRoot, "worker-keys", "validation"),
      "--worker-script", workerScript,
      "--artifacts-dir", validationArtifactsDir,
      ...optionalArg("--swarm-token", swarmToken),
      ...optionalArg("--job-lease-seconds", jobLeaseSeconds),
      ...optionalArg("--heartbeat-interval-ms", heartbeatIntervalMs),
    ])), validationJobs.length);
  } finally {
    await stopControl(validationControl.child);
  }
}

await runScript(leaderboardScript, [
  "--eval-artifacts-dir", evalArtifactsDir,
  "--output-dir", leaderboardDir,
  "--top-k", String(jobCount),
  ...optionalArg("--coordinator-url", requireValidation ? coordinatorUrl : undefined),
  ...optionalArg("--coordinator-token", requireValidation ? coordinatorToken : undefined),
  ...(requireValidation ? ["--require-verdict", "accepted"] : []),
]);

await runScript(modelPackageScript, [
  "--optimized-model", join(leaderboardDir, "optimized_model.json"),
  "--output-dir", modelPackageDir,
]);

await runScript(modelQueryScript, [
  "--package", join(modelPackageDir, "model_package.json"),
  "--eval-file", evalFile,
  "--output-dir", queryDir,
  "--require-correct", "true",
  ...optionalArg("--python", pythonBin),
]);

const coordinator = coordinatorUrl == null ? null : await verifyCoordinator({
  coordinatorUrl,
  artifactsDir,
  evalJobsFile,
  validationJobsFile: requireValidation ? validationJobsFile : undefined,
  expectedTrainJobs: jobCount,
  expectedEvalJobs: jobCount,
  expectedValidationJobs: validationJobs.length,
  requireAcceptedEvalArtifacts: requireValidation,
});
const optimized = JSON.parse(await readFile(join(leaderboardDir, "optimized_model.json"), "utf8")) as Record<string, unknown>;
const leaderboard = JSON.parse(await readFile(join(leaderboardDir, "leaderboard.json"), "utf8")) as { entries?: unknown[] };
if (!Array.isArray(leaderboard.entries) || leaderboard.entries.length !== jobCount) {
  throw new Error(`leaderboard has ${leaderboard.entries?.length ?? 0} entries, expected ${jobCount}`);
}
const selected = optimized.selected as Record<string, unknown> | null;

console.log(JSON.stringify({
  type: "marshall_ag_news_e2e_completed",
  run_id: runId,
  run_root: runRoot,
  coordinator_url: coordinatorUrl ?? null,
  train_jobs: jobCount,
  eval_jobs: jobCount,
  validation_jobs: validationJobs.length,
  artifacts_dir: artifactsDir,
  eval_artifacts_dir: evalArtifactsDir,
  validation_artifacts_dir: requireValidation ? validationArtifactsDir : null,
  leaderboard_dir: leaderboardDir,
  model_package: join(modelPackageDir, "model_package.json"),
  query_dir: queryDir,
  selected_adapter_id: selected?.adapter_id ?? null,
  selected_accuracy: selected?.accuracy ?? null,
  coordinator,
}, null, 2));

interface ControlProcess {
  child: ChildProcessWithoutNullStreams;
  addr: string;
}

interface CoordinatorVerificationOptions {
  coordinatorUrl: string;
  artifactsDir: string;
  evalJobsFile: string;
  validationJobsFile?: string;
  expectedTrainJobs: number;
  expectedEvalJobs: number;
  expectedValidationJobs: number;
  requireAcceptedEvalArtifacts: boolean;
}

async function verifyCoordinator(options: CoordinatorVerificationOptions) {
  const client = new CoordinatorClient(options.coordinatorUrl, { token: coordinatorToken });
  const trainJobIds = await trainingJobIds(options.artifactsDir);
  const evalJobs = parseEvalJobs(JSON.parse(await readFile(options.evalJobsFile, "utf8")));
  const validationJobs = options.validationJobsFile == null
    ? []
    : parseValidationJobs(JSON.parse(await readFile(options.validationJobsFile, "utf8")));
  if (trainJobIds.length !== options.expectedTrainJobs) {
    throw new Error(`coordinator verification found ${trainJobIds.length} train artifacts, expected ${options.expectedTrainJobs}`);
  }
  if (evalJobs.length !== options.expectedEvalJobs) {
    throw new Error(`coordinator verification found ${evalJobs.length} eval jobs, expected ${options.expectedEvalJobs}`);
  }
  if (validationJobs.length !== options.expectedValidationJobs) {
    throw new Error(`coordinator verification found ${validationJobs.length} validation jobs, expected ${options.expectedValidationJobs}`);
  }
  for (const jobId of trainJobIds) {
    const job = await client.getJob(jobId);
    const artifact = await client.getArtifact(jobId);
    if (job.status !== "completed") {
      throw new Error(`coordinator job ${jobId} is ${job.status ?? "missing status"}, expected completed`);
    }
    if (artifact.artifact_type !== "lora_adapter") {
      throw new Error(`coordinator artifact ${jobId} is ${artifact.artifact_type}, expected lora_adapter`);
    }
  }
  for (const job of evalJobs) {
    const persisted = await client.getJob(job.job_id);
    const artifact = await client.getArtifact(job.job_id);
    const spec = MarshallJobSchema.parse(persisted.job_spec);
    if (persisted.status !== "completed") {
      throw new Error(`coordinator eval job ${job.job_id} is ${persisted.status ?? "missing status"}, expected completed`);
    }
    if (spec.job_type !== "evaluate_adapter") {
      throw new Error(`coordinator eval job ${job.job_id} has invalid job_spec type`);
    }
    if (artifact.artifact_type !== "adapter_evaluation") {
      throw new Error(`coordinator artifact ${job.job_id} is ${artifact.artifact_type}, expected adapter_evaluation`);
    }
    if (options.requireAcceptedEvalArtifacts && artifact.verdict !== "accepted") {
      throw new Error(`coordinator eval artifact ${job.job_id} verdict is ${artifact.verdict ?? "unset"}, expected accepted`);
    }
  }
  for (const job of validationJobs) {
    const persisted = await client.getJob(job.job_id);
    const artifact = await client.getArtifact(job.job_id);
    const spec = MarshallJobSchema.parse(persisted.job_spec);
    if (persisted.status !== "completed") {
      throw new Error(`coordinator validation job ${job.job_id} is ${persisted.status ?? "missing status"}, expected completed`);
    }
    if (spec.job_type !== "validate_artifact") {
      throw new Error(`coordinator validation job ${job.job_id} has invalid job_spec type`);
    }
    if (artifact.artifact_type !== "artifact_validation") {
      throw new Error(`coordinator artifact ${job.job_id} is ${artifact.artifact_type}, expected artifact_validation`);
    }
  }
  return {
    train_jobs_completed: trainJobIds.length,
    eval_jobs_completed: evalJobs.length,
    validation_jobs_completed: validationJobs.length,
    accepted_eval_artifacts: options.requireAcceptedEvalArtifacts ? evalJobs.length : undefined,
  };
}

interface WorkerPoolResult {
  launched: number;
  completed: number;
  failed: number;
}

function parseWorkerPoolResult(stdout: string): WorkerPoolResult {
  const parsed = parseFirstJson(stdout);
  if (typeof parsed !== "object" || parsed == null) {
    throw new Error(`worker pool did not print JSON: ${stdout}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "marshall_worker_pool_completed") {
    throw new Error(`unexpected worker pool output type ${String(record.type)}`);
  }
  return {
    launched: numberValue(record.launched, "worker_pool.launched"),
    completed: numberValue(record.completed, "worker_pool.completed"),
    failed: numberValue(record.failed, "worker_pool.failed"),
  };
}

function assertWorkerPoolResult(label: string, result: WorkerPoolResult, expectedCompleted: number): void {
  if (result.completed !== expectedCompleted || result.failed !== 0) {
    throw new Error(`${label} worker pool completed ${result.completed}/${expectedCompleted} with ${result.failed} failed workers`);
  }
}

async function trainingJobIds(artifactsDirPath: string): Promise<string[]> {
  const entries = await readdir(artifactsDirPath, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = join(artifactsDirPath, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = TrainingArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.artifact_type === "lora_adapter") {
      ids.push(manifest.job_id);
    }
  }
  ids.sort();
  return ids;
}

function parseEvalJobs(value: unknown): AdapterEvaluationJob[] {
  if (!Array.isArray(value)) {
    throw new Error("evaluation jobs file must contain an array");
  }
  return value.map((job) => {
    const parsed = MarshallJobSchema.parse(job);
    if (parsed.job_type !== "evaluate_adapter") {
      throw new Error(`evaluation jobs file contains ${parsed.job_type}`);
    }
    return parsed;
  });
}

function parseValidationJobs(value: unknown): ArtifactValidationJob[] {
  if (!Array.isArray(value)) {
    throw new Error("validation jobs file must contain an array");
  }
  return value.map((job) => {
    const parsed = MarshallJobSchema.parse(job);
    if (parsed.job_type !== "validate_artifact") {
      throw new Error(`validation jobs file contains ${parsed.job_type}`);
    }
    return parsed;
  });
}

async function startControl(values: string[]): Promise<ControlProcess> {
  const child = spawnScript(controlScript, values);
  const started = await waitForControlStarted(child);
  const addr = started.addrs[0];
  if (addr == null) {
    throw new Error("control peer did not print a multiaddr");
  }
  return { child, addr };
}

function waitForControlStarted(child: ChildProcessWithoutNullStreams): Promise<{ addrs: string[] }> {
  return new Promise((resolveStarted, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`control peer did not start in time\n${stderr}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const parsed = parseFirstJson(stdout);
      if (parsed != null) {
        const record = parsed as Record<string, unknown>;
        if (record.type === "marshall_control_started" && Array.isArray(record.addrs)) {
          clearTimeout(timeout);
          resolveStarted({ addrs: record.addrs.map((item) => String(item)) });
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(`control peer exited before startup: ${exitCode ?? "unknown"}\n${stderr}`));
      }
    });
  });
}

async function stopControl(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null || child.killed) {
    return;
  }
  child.kill("SIGINT");
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 3_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

async function runScript(scriptPath: string, values: string[]): Promise<string> {
  const result = await runProcess(scriptCommand(scriptPath), [...scriptArgs(scriptPath), ...values]);
  return result.stdout;
}

function spawnScript(scriptPath: string, values: string[]): ChildProcessWithoutNullStreams {
  return spawn(scriptCommand(scriptPath), [...scriptArgs(scriptPath), ...values], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

function runProcess(command: string, values: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, values, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `${command} exited ${exitCode ?? "unknown"}`));
    });
  });
}

function scriptCommand(scriptPath: string): string {
  if (scriptPath.endsWith(".ts")) {
    return resolve("node_modules/.bin/tsx");
  }
  return process.execPath;
}

function scriptArgs(scriptPath: string): string[] {
  return [scriptPath];
}

function siblingScript(baseName: string): string {
  const jsPath = fileURLToPath(new URL(`./${baseName}.js`, import.meta.url));
  if (existsSync(jsPath)) {
    return jsPath;
  }
  return jsPath.replace(/\.js$/, ".ts");
}

function optionalArg(name: string, value: string | undefined): string[] {
  return value == null || value === "" ? [] : [name, value];
}

function parseFirstJson(value: string): unknown | null {
  const start = value.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(value.slice(start, index + 1));
      }
    }
  }
  return null;
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

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
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

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
