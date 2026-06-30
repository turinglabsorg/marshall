import { hostname } from "node:os";
import { join } from "node:path";
import { multiaddr } from "@multiformats/multiaddr";
import { defaultBackendForJob } from "./jobs.js";
import type { Backend, JobType, MarshallJob } from "./schemas.js";
import { runAdapterEvaluation, runArtifactValidation, runMlxLoraTraining, runMlxSmokeTraining, runToyTraining } from "./training-runner.js";
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
const workerId = args["worker-id"] ?? process.env.MARSHALL_WORKER_ID ?? `${hostname()}-${backend}`;
const worker = await WorkerPeer.create({
  privateKeyPath: args.key ?? process.env.MARSHALL_WORKER_KEY ?? ".marshall/worker.key",
  workerId,
  controlAddr: controlAddrs(controlAddr)[0],
  controlAddrs: controlAddrs(controlAddr),
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

  const runnableJob = await materializeJobInputs(claim.job);
  const training = await runClaimedJob(runnableJob);
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
    worker_id: workerId,
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
  if (job.job_type === "evaluate_adapter") {
    return runAdapterEvaluation(job, {
      outputRoot,
      datasetCacheRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
    });
  }
  if (job.job_type === "train_adapter") {
    const config = job.training_config;
    return runMlxLoraTraining(job, {
      outputRoot,
      datasetCacheRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
      model: config?.model ?? args.model ?? process.env.MARSHALL_MODEL,
      iters: config?.iters ?? numberArg(args.iters ?? process.env.MARSHALL_ITERS, 20),
      batchSize: config?.batch_size ?? numberArg(args["batch-size"] ?? process.env.MARSHALL_BATCH_SIZE, 1),
      learningRate: config?.learning_rate ?? numberArg(args["learning-rate"] ?? process.env.MARSHALL_LEARNING_RATE, 1e-5),
      numLayers: config?.num_layers ?? numberArg(args["num-layers"] ?? process.env.MARSHALL_NUM_LAYERS, 4),
      maxSeqLength: config?.max_seq_length ?? numberArg(args["max-seq-length"] ?? process.env.MARSHALL_MAX_SEQ_LENGTH, 512),
      stepsPerReport: config?.steps_per_report ?? numberArg(args["steps-per-report"] ?? process.env.MARSHALL_STEPS_PER_REPORT, 10),
      stepsPerEval: config?.steps_per_eval ?? numberArg(args["steps-per-eval"] ?? process.env.MARSHALL_STEPS_PER_EVAL, 20),
      valBatches: config?.val_batches ?? numberArg(args["val-batches"] ?? process.env.MARSHALL_VAL_BATCHES, -1),
      seed: config?.seed ?? numberArg(args.seed ?? process.env.MARSHALL_SEED, 42),
      maskPrompt: config?.mask_prompt ?? (args["no-mask-prompt"] === "true"
        ? false
        : booleanArg(args["mask-prompt"] ?? process.env.MARSHALL_MASK_PROMPT, true)),
      gradCheckpoint: config?.grad_checkpoint ?? booleanArg(args["grad-checkpoint"] ?? process.env.MARSHALL_GRAD_CHECKPOINT, false),
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

async function materializeJobInputs(job: MarshallJob): Promise<MarshallJob> {
  const inputArtifactsDir = join(args["input-artifacts-dir"] ?? process.env.MARSHALL_INPUT_ARTIFACTS_DIR ?? ".marshall/input-artifacts", workerId);
  const chunkBytes = numberArg(args["artifact-chunk-bytes"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_BYTES, 1024 * 1024);
  const maxChunkRetries = positiveIntegerArg(args["artifact-chunk-retries"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_RETRIES, 3);

  if (job.job_type === "evaluate_adapter" && isMarshallArtifactUri(job.adapter.artifact_uri)) {
    const sourceJobId = marshallArtifactJobId(job.adapter.artifact_uri) ?? job.adapter.source_job_id ?? job.adapter.adapter_id;
    const manifest = await worker.fetchArtifactFromControl(sourceJobId, job.adapter.artifact_hash, inputArtifactsDir, {
      chunkBytes,
      maxChunkRetries,
    });
    return {
      ...job,
      adapter: {
        ...job.adapter,
        artifact_uri: manifest.artifact_uri,
        config_hash: job.adapter.config_hash ?? manifest.config_hash,
      },
    };
  }

  if (job.job_type === "validate_artifact") {
    const targetUri = job.target.metrics_uri ?? job.target.artifact_uri;
    if (isMarshallArtifactUri(targetUri)) {
      const sourceJobId = marshallArtifactJobId(targetUri) ?? job.target.job_id;
      const manifest = await worker.fetchArtifactFromControl(sourceJobId, job.target.artifact_hash, inputArtifactsDir, {
        chunkBytes,
        maxChunkRetries,
      });
      return {
        ...job,
        target: {
          ...job.target,
          artifact_uri: manifest.artifact_uri,
          metrics_uri: job.target.metrics_uri == null ? undefined : manifest.metrics_uri ?? manifest.artifact_uri,
        },
      };
    }
  }

  return job;
}

function isMarshallArtifactUri(value: string): boolean {
  return value.startsWith("marshall-artifact://") || value.startsWith("marshall-artifact:");
}

function marshallArtifactJobId(value: string): string | undefined {
  const parsed = new URL(value);
  const id = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  return id === "" ? undefined : id;
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

function controlAddrs(primary: string): ReturnType<typeof multiaddr>[] {
  const values = [
    ...splitList(primary),
    ...splitList(args["control-addrs"] ?? process.env.MARSHALL_CONTROL_ADDRS ?? ""),
  ].filter(Boolean);
  const deduped = [...new Set(values)];
  if (deduped.length === 0) {
    throw new Error("--control or MARSHALL_CONTROL_ADDR is required");
  }
  return deduped.map((value) => multiaddr(value));
}

function jobTypeArg(value: string): Extract<JobType, "train_toy_model" | "train_mlx_smoke" | "train_adapter" | "evaluate_adapter" | "validate_artifact"> {
  if (value === "train_toy_model" || value === "train_mlx_smoke" || value === "train_adapter" || value === "evaluate_adapter" || value === "validate_artifact") {
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
