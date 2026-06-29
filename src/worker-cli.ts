import { hostname } from "node:os";
import { multiaddr } from "@multiformats/multiaddr";
import { defaultBackendForJob } from "./jobs.js";
import type { Backend, JobType, TrainingJob } from "./schemas.js";
import { runMlxLoraTraining, runMlxSmokeTraining, runToyTraining } from "./training-runner.js";
import { WorkerPeer } from "./worker-peer.js";

const args = parseArgs(process.argv.slice(2));
const controlAddr = args.control ?? process.env.MARSHALL_CONTROL_ADDR;

if (controlAddr == null) {
  throw new Error("--control or MARSHALL_CONTROL_ADDR is required");
}

const jobType = jobTypeArg(args["job-type"] ?? process.env.MARSHALL_JOB_TYPE ?? "train_toy_model");
const backend = backendArg(args.backend ?? process.env.MARSHALL_BACKEND ?? defaultBackendForJob(jobType));
const worker = await WorkerPeer.create({
  privateKeyPath: args.key ?? process.env.MARSHALL_WORKER_KEY ?? ".marshall/worker.key",
  workerId: args["worker-id"] ?? process.env.MARSHALL_WORKER_ID ?? `${hostname()}-${backend}`,
  controlAddr: multiaddr(controlAddr),
  listen: splitList(args.listen ?? process.env.MARSHALL_WORKER_LISTEN ?? "/ip4/0.0.0.0/tcp/0"),
  backend,
  supportedJobs: [jobType],
  memoryGb: numberArg(args["memory-gb"] ?? process.env.MARSHALL_MEMORY_GB, 32),
  tokensPerSecond: numberArg(args["tokens-per-second"] ?? process.env.MARSHALL_TOKENS_PER_SECOND, 1000),
});

let claimedJob: TrainingJob | undefined;

try {
  await worker.register();
  await worker.heartbeat("idle");
  const claim = await worker.claimJob(jobType, maxTokensForJob(jobType));

  if (!claim.accepted || claim.job == null) {
    throw new Error(`no job assigned: ${claim.reason ?? "unknown reason"}`);
  }
  claimedJob = claim.job;

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
  await worker.stop();
}

async function runClaimedJob(job: TrainingJob) {
  const outputRoot = args["artifacts-dir"] ?? process.env.MARSHALL_ARTIFACTS_DIR ?? ".marshall/artifacts";
  if (job.job_type === "train_adapter") {
    return runMlxLoraTraining(job, {
      outputRoot,
      pythonBin: args.python ?? process.env.MARSHALL_PYTHON,
      model: args.model ?? process.env.MARSHALL_MODEL,
      iters: numberArg(args.iters ?? process.env.MARSHALL_ITERS, 20),
      batchSize: numberArg(args["batch-size"] ?? process.env.MARSHALL_BATCH_SIZE, 1),
      learningRate: numberArg(args["learning-rate"] ?? process.env.MARSHALL_LEARNING_RATE, 1e-5),
      numLayers: numberArg(args["num-layers"] ?? process.env.MARSHALL_NUM_LAYERS, 4),
      maxSeqLength: numberArg(args["max-seq-length"] ?? process.env.MARSHALL_MAX_SEQ_LENGTH, 512),
      maskPrompt: args["no-mask-prompt"] === "true"
        ? false
        : booleanArg(args["mask-prompt"] ?? process.env.MARSHALL_MASK_PROMPT, true),
      gradCheckpoint: booleanArg(args["grad-checkpoint"] ?? process.env.MARSHALL_GRAD_CHECKPOINT, false),
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

function jobTypeArg(value: string): Extract<JobType, "train_toy_model" | "train_mlx_smoke" | "train_adapter"> {
  if (value === "train_toy_model" || value === "train_mlx_smoke" || value === "train_adapter") {
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
