import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CoordinatorClient } from "./coordinator-client.js";
import { buildDatasetManifest } from "./dataset-manifest.js";
import { createTrainingJobs } from "./jobs.js";

const args = parseArgs(process.argv.slice(2));
const inputJsonl = splitList(args["input-jsonl"] ?? process.env.MARSHALL_DATASET_INPUT_JSONL ?? "");
const requestedDatasetId = args["dataset-id"] ?? process.env.MARSHALL_DATASET_ID;
const datasetId = requestedDatasetId ?? "marshall-external-jsonl";
const datasetDir = resolve(
  args["dataset-dir"]
  ?? process.env.MARSHALL_DATASET_DIR
  ?? (inputJsonl.length > 0 ? `.marshall/datasets/${safeId(datasetId)}` : ".marshall/datasets/manifest"),
);

let manifestResult = null;
if (inputJsonl.length > 0) {
  manifestResult = await buildDatasetManifest({
    inputJsonl,
    outputDir: datasetDir,
    datasetId,
    version: args.version ?? process.env.MARSHALL_DATASET_VERSION ?? new Date().toISOString().slice(0, 10),
    schema: args.schema ?? process.env.MARSHALL_DATASET_SCHEMA ?? "mlx-chat-jsonl",
    license: args.license ?? process.env.MARSHALL_DATASET_LICENSE ?? "external-local-test",
    shardCount: positiveIntegerArg(args["shard-count"] ?? process.env.MARSHALL_DATASET_SHARD_COUNT, 8),
    validEvery: positiveIntegerArg(args["valid-every"] ?? process.env.MARSHALL_DATASET_VALID_EVERY, 20),
    maxRecords: optionalPositiveIntegerArg(args["max-records"] ?? process.env.MARSHALL_DATASET_MAX_RECORDS),
    textField: args["text-field"] ?? process.env.MARSHALL_DATASET_TEXT_FIELD ?? "text",
    instructionField: optionalStringArg(args["instruction-field"] ?? process.env.MARSHALL_DATASET_INSTRUCTION_FIELD),
    responseField: optionalStringArg(args["response-field"] ?? process.env.MARSHALL_DATASET_RESPONSE_FIELD),
    contextField: optionalStringArg(args["context-field"] ?? process.env.MARSHALL_DATASET_CONTEXT_FIELD),
    systemPrompt: optionalStringArg(args["system-prompt"] ?? process.env.MARSHALL_DATASET_SYSTEM_PROMPT),
    baseUri: trimTrailingSlash(args["base-uri"] ?? process.env.MARSHALL_DATASET_BASE_URI),
  });
}

const manifestPath = join(datasetDir, "manifest.json");
const manifest = await readDatasetManifest(manifestPath);
const runId = args["run-id"] ?? process.env.MARSHALL_RUN_ID ?? `run_${safeId(manifest.dataset_id)}_${timestampId()}`;
const roundId = args["round-id"] ?? process.env.MARSHALL_ROUND_ID ?? "round_001";
const jobCount = optionalPositiveIntegerArg(args["job-count"] ?? process.env.MARSHALL_JOB_COUNT) ?? manifest.shards.length;
const jobIdPrefix = args["job-id-prefix"] ?? process.env.MARSHALL_JOB_ID_PREFIX ?? `job_${safeId(manifest.dataset_id)}`;
const runDir = resolve(args["run-dir"] ?? process.env.MARSHALL_RUN_DIR ?? `.marshall/runs/${runId}`);
const jobsDir = join(runDir, "jobs");
const jobsFile = join(jobsDir, "train-adapters.json");
const runFile = join(runDir, "run.json");
const coordinatorUrl = args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL;
const publish = booleanArg(args.publish ?? process.env.MARSHALL_PUBLISH_JOBS, coordinatorUrl != null && coordinatorUrl !== "");

const jobs = createTrainingJobs("train_adapter", jobCount, {
  jobId: jobIdPrefix,
  runId,
  roundId,
  adapterDataset: "manifest",
  adapterDatasetDir: datasetDir,
});

await mkdir(jobsDir, { recursive: true });
await writeFile(jobsFile, JSON.stringify(jobs, null, 2) + "\n", "utf8");

let publishedJobs = 0;
if (publish) {
  if (coordinatorUrl == null || coordinatorUrl === "") {
    throw new Error("--publish requires --coordinator-url or MARSHALL_COORDINATOR_URL");
  }
  const coordinator = new CoordinatorClient(coordinatorUrl, {
    token: args["coordinator-token"] ?? process.env.MARSHALL_COORDINATOR_TOKEN,
  });
  await coordinator.initializeJobs(jobs);
  publishedJobs = jobs.length;
}

const runBundle = {
  type: "marshall_dataset_run_prepared",
  run_id: runId,
  round_id: roundId,
  job_type: "train_adapter",
  dataset_id: manifest.dataset_id,
  dataset_version: manifest.version,
  dataset_dir: datasetDir,
  manifest_path: manifestPath,
  manifest_created: manifestResult != null,
  jobs_file: jobsFile,
  job_count: jobs.length,
  shard_count: manifest.shards.length,
  token_estimate: manifest.token_estimate,
  coordinator_url: coordinatorUrl ?? null,
  published_jobs: publishedJobs,
  control: {
    job_type: "train_adapter",
    jobs_file: jobsFile,
    adapter_dataset: "manifest",
    adapter_dataset_dir: datasetDir,
    run_id: runId,
  },
};

await writeFile(runFile, JSON.stringify(runBundle, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  ...runBundle,
  run_file: runFile,
}, null, 2));

interface DatasetManifestSummary {
  dataset_id: string;
  version: string;
  token_estimate: number;
  shards: unknown[];
}

async function readDatasetManifest(path: string): Promise<DatasetManifestSummary> {
  const value = JSON.parse(await readFile(path, "utf8")) as {
    dataset_id?: unknown;
    version?: unknown;
    token_estimate?: unknown;
    shards?: unknown;
  };
  if (typeof value.dataset_id !== "string" || value.dataset_id.length === 0) {
    throw new Error(`${path}: invalid dataset_id`);
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error(`${path}: invalid version`);
  }
  if (typeof value.token_estimate !== "number" || !Number.isFinite(value.token_estimate)) {
    throw new Error(`${path}: invalid token_estimate`);
  }
  if (!Array.isArray(value.shards) || value.shards.length === 0) {
    throw new Error(`${path}: invalid shards`);
  }
  return {
    dataset_id: value.dataset_id,
    version: value.version,
    token_estimate: value.token_estimate,
    shards: value.shards,
  };
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return value.replace(/\/+$/, "");
}

function optionalStringArg(value: string | undefined): string | undefined {
  if (value == null || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function positiveIntegerArg(value: string | undefined, fallback: number): number {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value ?? fallback}`);
  }
  return parsed;
}

function optionalPositiveIntegerArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return positiveIntegerArg(value, 1);
}

function booleanArg(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") {
    return fallback;
  }
  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no") {
    return false;
  }
  throw new Error(`invalid boolean: ${value}`);
}

function safeId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe === "" ? "dataset" : safe;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
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
