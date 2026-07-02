import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CoordinatorClient, type CoordinatorArtifact, type CoordinatorJob } from "./coordinator-client.js";
import { createValidationTopUpJobs } from "./validation-top-up.js";

const args = parseArgs(process.argv.slice(2));
const coordinatorUrl = requiredArg("coordinator-url", args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL);
const coordinatorToken = args["coordinator-token"] ?? process.env.MARSHALL_COORDINATOR_TOKEN;
const coordinator = new CoordinatorClient(coordinatorUrl, { token: coordinatorToken });

const runId = requiredArg("run-id", args["run-id"] ?? process.env.MARSHALL_RUN_ID);
const roundId = requiredArg("round-id", args["round-id"] ?? process.env.MARSHALL_ROUND_ID);
const validationRunId = args["validation-run-id"] ?? process.env.MARSHALL_VALIDATION_RUN_ID ?? `${runId}_validation`;
const jobsDir = resolve(requiredArg("jobs-dir", args["jobs-dir"] ?? process.env.MARSHALL_JOBS_DIR));
const trainJobPrefix = requiredArg("train-job-prefix", args["train-job-prefix"] ?? process.env.MARSHALL_TRAIN_JOB_PREFIX);
const evalJobPrefix = requiredArg("eval-job-prefix", args["eval-job-prefix"] ?? process.env.MARSHALL_EVAL_JOB_PREFIX);
const validationJobPrefix = requiredArg("validation-job-prefix", args["validation-job-prefix"] ?? process.env.MARSHALL_VALIDATION_JOB_PREFIX);
const intervalMs = positiveIntegerArg(args["interval-ms"] ?? process.env.MARSHALL_ROUND_INTERVAL_MS ?? "15000");
const once = booleanArg(args.once ?? process.env.MARSHALL_ROUND_ONCE, false);
const stateFile = args["state-file"] ?? process.env.MARSHALL_ROUND_STATE_FILE ?? join(jobsDir, "round-daemon-state.json");

await mkdir(jobsDir, { recursive: true });

const selectedState = await readSelectedState();
if (selectedState != null) {
  console.log(JSON.stringify(selectedState, null, 2));
  process.exit(0);
}

let iterations = 0;
while (true) {
  iterations += 1;
  const action = await tick();
  console.log(JSON.stringify(action, null, 2));
  await writeState(action);
  if (once || action.action === "selected") {
    break;
  }
  await sleep(intervalMs);
}

async function tick() {
  const [jobs, artifacts] = await Promise.all([
    coordinator.jobs(),
    coordinator.artifacts(),
  ]);
  const trainJobs = jobsByPrefix(jobs, trainJobPrefix, "train_adapter");
  const evalJobs = jobsByPrefix(jobs, evalJobPrefix, "evaluate_adapter");
  const validationJobs = jobsByPrefix(jobs, validationJobPrefix, "validate_artifact");
  const loraArtifacts = artifactsByPrefix(artifacts, trainJobPrefix, "lora_adapter");
  const evalArtifacts = artifactsByPrefix(artifacts, evalJobPrefix, "adapter_evaluation");
  const finalizedEvalArtifacts = evalArtifacts.filter(isFinalizedArtifact);

  if (evalJobs.length === 0) {
    if (activeJobs(trainJobs).length > 0 || loraArtifacts.length === 0) {
      return daemonAction("wait_train", jobs, artifacts, {
        reason: "training jobs are still active or no lora artifacts are available",
        train_jobs: summarizeJobs(trainJobs),
        lora_artifacts: loraArtifacts.length,
      });
    }
    const result = await runRoundAdvance([
      "--coordinator-url", coordinatorUrl,
      "--phase", "evaluation",
      "--jobs-dir", jobsDir,
      "--run-id", runId,
      "--round-id", roundId,
      "--eval-run-id", args["eval-run-id"] ?? `${runId}_eval`,
      "--eval-file", requiredArg("eval-file", args["eval-file"] ?? process.env.MARSHALL_EVAL_FILE),
      "--eval-uri", requiredArg("eval-uri", args["eval-uri"] ?? process.env.MARSHALL_EVAL_URI),
      "--eval-kind", requiredArg("eval-kind", args["eval-kind"] ?? process.env.MARSHALL_EVAL_KIND),
      "--model", requiredArg("model", args.model ?? process.env.MARSHALL_MODEL),
      "--max-examples", requiredArg("max-examples", args["max-examples"] ?? process.env.MARSHALL_EVAL_EXAMPLES),
      "--max-tokens", requiredArg("max-tokens", args["max-tokens"] ?? process.env.MARSHALL_EVAL_MAX_TOKENS),
      ...optionalValueArg("--eval-min-memory-gb", args["eval-min-memory-gb"] ?? process.env.MARSHALL_EVAL_MIN_MEMORY_GB ?? args["min-memory-gb"] ?? process.env.MARSHALL_MIN_MEMORY_GB),
      "--eval-job-prefix", evalJobPrefix,
      "--adapter-job-prefix", trainJobPrefix,
      "--publish", "true",
    ]);
    return daemonAction("scheduled_evaluation", jobs, artifacts, { result });
  }

  if (validationJobs.length === 0) {
    if (activeJobs(evalJobs).length > 0 || evalArtifacts.length === 0) {
      return daemonAction("wait_evaluation", jobs, artifacts, {
        reason: "evaluation jobs are still active or no evaluation artifacts are available",
        eval_jobs: summarizeJobs(evalJobs),
        eval_artifacts: evalArtifacts.length,
      });
    }
    const artifactsFile = await writeArtifactSnapshot("evaluation-artifacts", evalArtifacts);
    const result = await runRoundAdvance([
      "--coordinator-url", coordinatorUrl,
      "--artifacts-file", artifactsFile,
      "--phase", "validation",
      "--jobs-dir", jobsDir,
      "--run-id", runId,
      "--round-id", roundId,
      "--validation-run-id", validationRunId,
      "--validation-job-prefix", validationJobPrefix,
      "--validators-per-artifact", requiredArg("validators-per-artifact", args["validators-per-artifact"] ?? process.env.MARSHALL_VALIDATORS_PER_ARTIFACT),
      "--quorum", requiredArg("quorum", args.quorum ?? process.env.MARSHALL_VALIDATION_QUORUM),
      "--min-accuracy", requiredArg("min-accuracy", args["min-accuracy"] ?? process.env.MARSHALL_VALIDATION_MIN_ACCURACY),
      "--max-invalid-rate", requiredArg("max-invalid-rate", args["max-invalid-rate"] ?? process.env.MARSHALL_VALIDATION_MAX_INVALID_RATE),
      "--min-examples", requiredArg("min-examples", args["min-examples"] ?? process.env.MARSHALL_VALIDATION_MIN_EXAMPLES),
      ...optionalValueArg("--validation-min-memory-gb", args["validation-min-memory-gb"] ?? process.env.MARSHALL_VALIDATION_MIN_MEMORY_GB),
      "--publish", "true",
    ]);
    return daemonAction("scheduled_validation", jobs, artifacts, { result });
  }

  const activeValidationJobs = activeJobs(validationJobs);
  if (activeValidationJobs.length > 0 || evalArtifacts.length === 0) {
    return daemonAction("wait_validation", jobs, artifacts, {
      reason: "validation jobs are still active or no evaluation artifacts are available",
      validation_jobs: summarizeJobs(validationJobs),
      eval_artifacts: evalArtifacts.length,
      finalized_eval_artifacts: finalizedEvalArtifacts.length,
    });
  }
  const unfinalizedEvalArtifacts = evalArtifacts.filter((artifact) => !isFinalizedArtifact(artifact));
  if (unfinalizedEvalArtifacts.length > 0) {
    const policy = validationPolicyArgs();
    const topUpJobs = createValidationTopUpJobs({
      artifacts: unfinalizedEvalArtifacts,
      validationJobs,
      runId: validationRunId,
      roundId,
      jobPrefix: validationJobPrefix,
      quorum: policy.quorum,
      minMemoryGb: optionalPositiveNumberArg(args["validation-min-memory-gb"] ?? process.env.MARSHALL_VALIDATION_MIN_MEMORY_GB),
      policy,
    });
    if (topUpJobs.length === 0) {
      return daemonAction("wait_validation", jobs, artifacts, {
        reason: "evaluation verdicts are not finalized but no validation top-up jobs are available",
        validation_jobs: summarizeJobs(validationJobs),
        eval_artifacts: evalArtifacts.length,
        finalized_eval_artifacts: finalizedEvalArtifacts.length,
      });
    }
    const outputFile = join(jobsDir, `validate-artifacts-top-up-${String(iterations).padStart(6, "0")}.json`);
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, JSON.stringify(topUpJobs, null, 2) + "\n", "utf8");
    await coordinator.initializeJobs(topUpJobs);
    return daemonAction("scheduled_validation_top_up", jobs, artifacts, {
      reason: "evaluation verdicts need additional validator quorum votes",
      jobs_file: outputFile,
      published_jobs: topUpJobs.length,
      pending_eval_artifacts: unfinalizedEvalArtifacts.length,
      validation_jobs: summarizeJobs(validationJobs),
      eval_artifacts: evalArtifacts.length,
      finalized_eval_artifacts: finalizedEvalArtifacts.length,
    });
  }

  const artifactsFile = await writeArtifactSnapshot("evaluation-artifacts-finalized", evalArtifacts);
  const result = await runRoundAdvance([
    "--artifacts-file", artifactsFile,
    "--phase", "selection",
    "--jobs-dir", jobsDir,
    "--run-id", runId,
    "--round-id", roundId,
    "--artifact-store-dir", requiredArg("artifact-store-dir", args["artifact-store-dir"] ?? process.env.MARSHALL_ARTIFACT_STORE_DIR),
    "--adapter-artifacts-dir", args["adapter-artifacts-dir"] ?? process.env.MARSHALL_ADAPTER_ARTIFACTS_DIR ?? requiredArg("artifact-store-dir", args["artifact-store-dir"] ?? process.env.MARSHALL_ARTIFACT_STORE_DIR),
    "--leaderboard-dir", requiredArg("leaderboard-dir", args["leaderboard-dir"] ?? process.env.MARSHALL_LEADERBOARD_DIR),
    "--package-dir", requiredArg("package-dir", args["package-dir"] ?? process.env.MARSHALL_MODEL_PACKAGE_DIR),
    "--top-k", requiredArg("top-k", args["top-k"] ?? process.env.MARSHALL_TOP_K),
    "--require-verdict", requiredArg("require-verdict", args["require-verdict"] ?? process.env.MARSHALL_LEADERBOARD_REQUIRE_VERDICT),
  ]);
  return daemonAction("selected", jobs, artifacts, { result });
}

function jobsByPrefix(jobs: CoordinatorJob[], prefix: string, jobType: string): CoordinatorJob[] {
  return jobs
    .filter((job) => job.job_type === jobType && job.job_id.startsWith(prefix))
    .sort((left, right) => left.job_id.localeCompare(right.job_id));
}

function artifactsByPrefix(artifacts: CoordinatorArtifact[], prefix: string, artifactType: string): CoordinatorArtifact[] {
  return artifacts
    .filter((artifact) => artifact.artifact_type === artifactType && artifact.job_id.startsWith(prefix))
    .sort((left, right) => left.job_id.localeCompare(right.job_id));
}

function activeJobs(jobs: CoordinatorJob[]): CoordinatorJob[] {
  return jobs.filter((job) => {
    const status = job.status ?? "";
    return status === "" || status === "queued" || status === "claimed" || status === "running";
  });
}

function isFinalizedArtifact(artifact: CoordinatorArtifact): boolean {
  return artifact.verdict_status === "finalized" || (artifact.verdict != null && artifact.verdict !== "");
}

function summarizeJobs(jobs: CoordinatorJob[]) {
  return {
    total: jobs.length,
    queued: jobs.filter((job) => job.status === "queued" || job.status == null || job.status === "").length,
    claimed: jobs.filter((job) => job.status === "claimed").length,
    running: jobs.filter((job) => job.status === "running").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
  };
}

async function writeArtifactSnapshot(name: string, artifacts: CoordinatorArtifact[]): Promise<string> {
  const path = join(jobsDir, `${name}.json`);
  await writeFile(path, JSON.stringify(artifacts, null, 2) + "\n", "utf8");
  return path;
}

async function runRoundAdvance(values: string[]) {
  const env: Record<string, string> = {};
  if (coordinatorToken != null && coordinatorToken !== "") {
    env.MARSHALL_COORDINATOR_TOKEN = coordinatorToken;
  }
  const result = await runProcess(process.execPath, [siblingScript("round-orchestrator-cli"), ...values], env);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `round-orchestrator exited ${result.exitCode}`);
  }
  return JSON.parse(result.stdout);
}

function runProcess(command: string, values: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, values, {
      env: {
        ...process.env,
        ...env,
      },
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

function siblingScript(baseName: string): string {
  const jsPath = fileURLToPath(new URL(`./${baseName}.js`, import.meta.url));
  if (existsSync(jsPath)) {
    return jsPath;
  }
  return jsPath.replace(/\.js$/, ".ts");
}

function daemonAction(action: string, jobs: CoordinatorJob[], artifacts: CoordinatorArtifact[], details: Record<string, unknown>) {
  return {
    type: "marshall_round_daemon",
    action,
    iteration: iterations,
    run_id: runId,
    round_id: roundId,
    generated_at: new Date().toISOString(),
    jobs: {
      train_adapter: summarizeJobs(jobsByPrefix(jobs, trainJobPrefix, "train_adapter")),
      evaluate_adapter: summarizeJobs(jobsByPrefix(jobs, evalJobPrefix, "evaluate_adapter")),
      validate_artifact: summarizeJobs(jobsByPrefix(jobs, validationJobPrefix, "validate_artifact")),
    },
    artifacts: {
      lora_adapter: artifactsByPrefix(artifacts, trainJobPrefix, "lora_adapter").length,
      adapter_evaluation: artifactsByPrefix(artifacts, evalJobPrefix, "adapter_evaluation").length,
    },
    ...details,
  };
}

async function writeState(action: unknown): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(action, null, 2) + "\n", "utf8");
}

async function readSelectedState(): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.type !== "marshall_round_daemon" || parsed.action !== "selected") {
    return null;
  }
  if (parsed.run_id !== runId || parsed.round_id !== roundId) {
    return null;
  }
  return {
    type: "marshall_round_daemon",
    action: "already_selected",
    run_id: runId,
    round_id: roundId,
    generated_at: new Date().toISOString(),
    state_file: stateFile,
    selected_at: typeof parsed.generated_at === "string" ? parsed.generated_at : null,
    result: isRecord(parsed.result) ? parsed.result : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error != null
    && "code" in error
    && (error as { code?: unknown }).code === code;
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

function optionalValueArg(name: string, value: string | undefined): string[] {
  if (value == null || value.trim() === "") {
    return [];
  }
  return [name, value];
}

function validationPolicyArgs() {
  const quorum = positiveIntegerArg(requiredArg("quorum", args.quorum ?? process.env.MARSHALL_VALIDATION_QUORUM));
  return {
    min_accuracy: numberArg(requiredArg("min-accuracy", args["min-accuracy"] ?? process.env.MARSHALL_VALIDATION_MIN_ACCURACY)),
    max_invalid_rate: numberArg(requiredArg("max-invalid-rate", args["max-invalid-rate"] ?? process.env.MARSHALL_VALIDATION_MAX_INVALID_RATE)),
    min_examples: positiveIntegerArg(requiredArg("min-examples", args["min-examples"] ?? process.env.MARSHALL_VALIDATION_MIN_EXAMPLES)),
    quorum,
  };
}

function optionalPositiveNumberArg(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid positive number: ${value}`);
  }
  return parsed;
}

function numberArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`);
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

function booleanArg(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") {
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
