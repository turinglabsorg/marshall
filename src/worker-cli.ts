import { hostname } from "node:os";
import { multiaddr } from "@multiformats/multiaddr";
import { defaultBackendForJob } from "./jobs.js";
import type { Backend, JobType, MarshallJob } from "./schemas.js";
import { runAdapterEvaluation, runArtifactValidation, runMlxLoraTraining, runMlxSmokeTraining, runTextClassifierEvaluation, runTextClassifierTraining, runToyTraining } from "./training-runner.js";
import { WorkerPeer } from "./worker-peer.js";

const args = parseArgs(process.argv.slice(2));
const controlAddr = args.control ?? process.env.MARSHALL_CONTROL_ADDR;

if (controlAddr == null) {
  throw new Error("--control or MARSHALL_CONTROL_ADDR is required");
}

const jobType = jobTypeArg(args["job-type"] ?? process.env.MARSHALL_JOB_TYPE ?? "train_toy_model");
const backend = backendArg(args.backend ?? process.env.MARSHALL_BACKEND ?? defaultBackendForJob(jobType));
const jobLeaseSeconds = positiveIntegerArg(args["job-lease-seconds"] ?? process.env.MARSHALL_JOB_LEASE_SECONDS, 300);
const heartbeatIntervalMs = positiveIntegerArg(args["heartbeat-interval-ms"] ?? process.env.MARSHALL_HEARTBEAT_INTERVAL_MS, 15_000);
const worker = await WorkerPeer.create({
  privateKeyPath: args.key ?? process.env.MARSHALL_WORKER_KEY ?? ".marshall/worker.key",
  workerId: args["worker-id"] ?? process.env.MARSHALL_WORKER_ID ?? `${hostname()}-${backend}`,
  controlAddr: multiaddr(controlAddr),
  listen: splitList(args.listen ?? process.env.MARSHALL_WORKER_LISTEN ?? "/ip4/0.0.0.0/tcp/0"),
  backend,
  supportedJobs: [jobType],
  memoryGb: numberArg(args["memory-gb"] ?? process.env.MARSHALL_MEMORY_GB, 32),
  tokensPerSecond: numberArg(args["tokens-per-second"] ?? process.env.MARSHALL_TOKENS_PER_SECOND, 1000),
  swarmToken: args["swarm-token"] ?? process.env.MARSHALL_SWARM_TOKEN,
});

let claimedJob: MarshallJob | undefined;
let stopHeartbeat = () => {};

try {
  await worker.register();
  await worker.heartbeat("idle");
  const claim = await worker.claimJob(jobType, maxTokensForJob(jobType));

  if (!claim.accepted || claim.job == null) {
    throw new Error(`no job assigned: ${claim.reason ?? "unknown reason"}`);
  }
  claimedJob = claim.job;
  await worker.heartbeat("working", claim.job.job_id, jobLeaseSeconds);
  stopHeartbeat = startHeartbeat(() => worker.heartbeat("working", claim.job!.job_id, jobLeaseSeconds), heartbeatIntervalMs);

  await worker.reportJobStatus({
    job_id: claim.job.job_id,
    status: "running",
    message: `${claim.job.job_type} runner started`,
  });

  const training = await runClaimedJob(claim.job);
  await worker.publishArtifactManifest(training.manifest);
  await worker.reportJobStatus({
    job_id: claim.job.job_id,
    status: "completed",
    message: `${claim.job.job_type} runner completed`,
  });
  stopHeartbeat();
  stopHeartbeat = () => {};
  await worker.heartbeat("idle");

  console.log(JSON.stringify({
    type: "marshall_worker_completed",
    peer_id: worker.peerId,
    worker_id: args["worker-id"] ?? process.env.MARSHALL_WORKER_ID ?? `${hostname()}-${backend}`,
    job_id: claim.job.job_id,
    job_type: claim.job.job_type,
    artifact_hash: training.manifest.artifact_hash,
    artifact_uri: training.manifest.artifact_uri,
    metrics: training.metrics,
  }, null, 2));
} catch (error) {
  if (claimedJob != null) {
    try {
      await worker.reportJobStatus({
        job_id: claimedJob.job_id,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Ignore secondary reporting errors so the original failure remains visible.
    }
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  stopHeartbeat();
  await worker.stop();
}

async function runClaimedJob(job: MarshallJob) {
  const outputRoot = args["artifacts-dir"] ?? process.env.MARSHALL_ARTIFACTS_DIR ?? ".marshall/artifacts";
  const datasetCacheRoot = args["dataset-cache-dir"] ?? process.env.MARSHALL_DATASET_CACHE_DIR;
  if (job.job_type === "validate_artifact") {
    return runArtifactValidation(job, {
      outputRoot,
    });
  }
  if (job.job_type === "evaluate_text_classifier") {
    return runTextClassifierEvaluation(job, {
      outputRoot,
      datasetCacheRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
    });
  }
  if (job.job_type === "evaluate_adapter") {
    return runAdapterEvaluation(job, {
      outputRoot,
      datasetCacheRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
    });
  }
  if (job.job_type === "train_adapter") {
    return runMlxLoraTraining(job, {
      outputRoot,
      datasetCacheRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
      model: args.model ?? process.env.MARSHALL_MODEL,
      iters: numberArg(args.iters ?? process.env.MARSHALL_ITERS, 20),
      batchSize: numberArg(args["batch-size"] ?? process.env.MARSHALL_BATCH_SIZE, 1),
      learningRate: numberArg(args["learning-rate"] ?? process.env.MARSHALL_LEARNING_RATE, 1e-5),
      numLayers: numberArg(args["num-layers"] ?? process.env.MARSHALL_NUM_LAYERS, 4),
      maxSeqLength: numberArg(args["max-seq-length"] ?? process.env.MARSHALL_MAX_SEQ_LENGTH, 512),
      stepsPerReport: numberArg(args["steps-per-report"] ?? process.env.MARSHALL_STEPS_PER_REPORT, 10),
      stepsPerEval: numberArg(args["steps-per-eval"] ?? process.env.MARSHALL_STEPS_PER_EVAL, 20),
      valBatches: numberArg(args["val-batches"] ?? process.env.MARSHALL_VAL_BATCHES, -1),
      seed: numberArg(args.seed ?? process.env.MARSHALL_SEED, 42),
      maskPrompt: args["no-mask-prompt"] === "true"
        ? false
        : booleanArg(args["mask-prompt"] ?? process.env.MARSHALL_MASK_PROMPT, true),
      gradCheckpoint: booleanArg(args["grad-checkpoint"] ?? process.env.MARSHALL_GRAD_CHECKPOINT, false),
    });
  }
  if (job.job_type === "train_text_classifier") {
    return runTextClassifierTraining(job, {
      outputRoot,
      datasetCacheRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
      alpha: numberArg(args.alpha ?? process.env.MARSHALL_TEXT_CLASSIFIER_ALPHA, 1.0),
    });
  }
  if (job.job_type === "train_mlx_smoke") {
    return runMlxSmokeTraining(job, {
      outputRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
    });
  }
  if (job.job_type === "train_toy_model") {
    return runToyTraining(job, {
      outputRoot,
      datasetCacheRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
    });
  }
  throw new Error(`worker CLI cannot run job type: ${job.job_type}`);
}

function maxTokensForJob(value: JobType): number {
  if (value === "train_mlx_smoke") {
    return 4;
  }
  if (value === "train_adapter") {
    return 8_000;
  }
  if (value === "evaluate_adapter") {
    return 8_000;
  }
  if (value === "evaluate_text_classifier") {
    return 8_000;
  }
  if (value === "validate_artifact") {
    return 2_000;
  }
  return 2_000;
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

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function jobTypeArg(value: string): Extract<JobType, "train_toy_model" | "train_mlx_smoke" | "train_adapter" | "train_text_classifier" | "evaluate_adapter" | "evaluate_text_classifier" | "validate_artifact"> {
  if (value === "train_toy_model" || value === "train_mlx_smoke" || value === "train_adapter" || value === "train_text_classifier" || value === "evaluate_adapter" || value === "evaluate_text_classifier" || value === "validate_artifact") {
    return value;
  }
  throw new Error(`unsupported worker CLI job type: ${value}`);
}

function backendArg(value: string): Backend {
  if (value === "cpu" || value === "mlx" || value === "cuda") {
    return value;
  }
  throw new Error(`unsupported backend: ${value}`);
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value == null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}

function positiveIntegerArg(value: string | undefined, fallback: number): number {
  const parsed = numberArg(value, fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value ?? fallback}`);
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

function startHeartbeat(send: () => Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void send().catch(() => {
      // The main job path will report failures; heartbeat retries should not crash the worker.
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
