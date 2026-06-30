import { readFileSync } from "node:fs";
import { ControlPeer } from "./control-peer.js";
import { createTrainingJobs, type AdapterDatasetProfile } from "./jobs.js";
import { MarshallJobSchema, type JobType, type TrainingJob } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const jobType = jobTypeArg(args["job-type"] ?? process.env.MARSHALL_JOB_TYPE ?? "train_toy_model");
const jobCount = numberArg(args["job-count"] ?? process.env.MARSHALL_JOB_COUNT, 1);
const jobs = args["jobs-file"] ?? process.env.MARSHALL_JOBS_FILE
  ? readJobsFile(args["jobs-file"] ?? process.env.MARSHALL_JOBS_FILE!)
  : createTrainingJobs(trainingJobTypeArg(jobType), jobCount, {
    jobId: args["job-id"] ?? process.env.MARSHALL_JOB_ID,
    runId: args["run-id"] ?? process.env.MARSHALL_RUN_ID,
    roundId: args["round-id"] ?? process.env.MARSHALL_ROUND_ID,
    adapterDataset: adapterDatasetArg(args["adapter-dataset"] ?? process.env.MARSHALL_ADAPTER_DATASET),
    adapterDatasetDir: args["adapter-dataset-dir"] ?? process.env.MARSHALL_ADAPTER_DATASET_DIR,
  });
const control = await ControlPeer.create({
  privateKeyPath: args.key ?? process.env.MARSHALL_CONTROL_KEY ?? ".marshall/control.key",
  listen: splitList(args.listen ?? process.env.MARSHALL_CONTROL_LISTEN ?? "/ip4/0.0.0.0/tcp/4001"),
  coordinatorUrl: args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL,
  coordinatorToken: args["coordinator-token"] ?? process.env.MARSHALL_COORDINATOR_TOKEN,
  swarmToken: args["swarm-token"] ?? process.env.MARSHALL_SWARM_TOKEN,
  jobLeaseSeconds: numberArg(args["job-lease-seconds"] ?? process.env.MARSHALL_JOB_LEASE_SECONDS, 300),
  artifactStoreDir: args["artifact-store-dir"] ?? process.env.MARSHALL_ARTIFACT_STORE_DIR,
  artifactServeDirs: splitList(args["artifact-serve-dirs"] ?? process.env.MARSHALL_ARTIFACT_SERVE_DIRS ?? ""),
  artifactChunkBytes: numberArg(args["artifact-chunk-bytes"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_BYTES, 1024 * 1024),
  artifactMaxChunkRetries: numberArg(args["artifact-chunk-retries"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_RETRIES, 3),
  jobs,
});

console.log(JSON.stringify({
  type: "marshall_control_started",
  peer_id: control.peerId,
  addrs: control.multiaddrs.map((addr) => addr.toString()),
  job_type: jobType,
  job_count: jobs.length,
  jobs_file: args["jobs-file"] ?? process.env.MARSHALL_JOBS_FILE ?? null,
  adapter_dataset: args["adapter-dataset"] ?? process.env.MARSHALL_ADAPTER_DATASET ?? "marshall_instructions",
  coordinator_url: args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL ?? null,
  artifact_store_dir: args["artifact-store-dir"] ?? process.env.MARSHALL_ARTIFACT_STORE_DIR ?? null,
  artifact_serve_dirs: splitList(args["artifact-serve-dirs"] ?? process.env.MARSHALL_ARTIFACT_SERVE_DIRS ?? ""),
}, null, 2));

await waitForShutdown(async () => {
  await control.stop();
});

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

function jobTypeArg(value: string): JobType {
  if (
    value === "train_toy_model"
    || value === "train_mlx_smoke"
    || value === "train_adapter"
    || value === "evaluate_adapter"
    || value === "validate_artifact"
  ) {
    return value;
  }
  throw new Error(`unsupported CLI job type: ${value}`);
}

function trainingJobTypeArg(value: JobType): TrainingJob["job_type"] {
  if (value === "train_toy_model" || value === "train_mlx_smoke" || value === "train_adapter") {
    return value;
  }
  throw new Error(`${value} requires --jobs-file or MARSHALL_JOBS_FILE`);
}

function readJobsFile(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${path} must contain a JSON array of Marshall jobs`);
  }
  return raw.map((job) => MarshallJobSchema.parse(job));
}

function adapterDatasetArg(value: string | undefined): AdapterDatasetProfile | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (value === "marshall_instructions" || value === "ag_news") {
    return value;
  }
  throw new Error(`unsupported adapter dataset: ${value}`);
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

async function waitForShutdown(onShutdown: () => Promise<void>): Promise<void> {
  let stopping = false;
  await new Promise<void>((resolve) => {
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      void onShutdown().finally(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
