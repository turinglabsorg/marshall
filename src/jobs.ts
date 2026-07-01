import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TrainingJobSchema, type Backend, type JobType, type ResourceRequirements, type TrainingJob } from "./schemas.js";

export type AdapterDatasetProfile = "marshall_instructions" | "ag_news" | "manifest";

export interface TrainingJobOptions {
  jobId?: string;
  runId?: string;
  roundId?: string;
  adapterDataset?: AdapterDatasetProfile;
  adapterDatasetDir?: string;
  adapterTrainingConfig?: AdapterTrainingConfig;
  resourceRequirements?: ResourceRequirements;
}

export interface AdapterTrainingConfig {
  model: string;
  iters: number;
  batch_size: number;
  learning_rate: number;
  num_layers: number;
  max_seq_length: number;
  steps_per_report: number;
  steps_per_eval: number;
  val_batches: number;
  seed: number;
  mask_prompt: boolean;
  grad_checkpoint: boolean;
}

interface AdapterDatasetShardDefinition {
  id: string;
  uri: string;
  tokenEstimate: number;
  hash: string;
  files?: Array<{
    path: string;
    uri: string;
    sha256: string;
    bytes?: number;
  }>;
}

interface AdapterDatasetDefinition {
  datasetId: string;
  datasetVersion: string;
  schema: string;
  license: string;
  root: AdapterDatasetShardDefinition;
  shards: AdapterDatasetShardDefinition[];
}

interface AdapterDatasetManifest {
  dataset_id?: unknown;
  version?: unknown;
  schema?: unknown;
  license?: unknown;
  root_uri?: unknown;
  root_hash?: unknown;
  token_estimate?: unknown;
  shards?: unknown;
}

interface AdapterDatasetManifestShard {
  shard_id?: unknown;
  uri?: unknown;
  sha256?: unknown;
  token_estimate?: unknown;
  files?: unknown;
}

interface AdapterDatasetManifestShardFile {
  path?: unknown;
  uri?: unknown;
  sha256?: unknown;
  bytes?: unknown;
}

const MARSHALL_INSTRUCTIONS_DATASET_ID = "marshall-ops-synthetic-v1";
const MARSHALL_INSTRUCTIONS_DATASET_VERSION = "2026-06-29";
const MARSHALL_INSTRUCTIONS_SCHEMA = "mlx-chat-jsonl";
const MARSHALL_INSTRUCTIONS_LICENSE = "MIT";
const MARSHALL_INSTRUCTIONS_DATASET_HASH = "sha256:420fb2db6fafc0eafaf88a205318b1dd7662579cea030cbdc5b55c1a471e4cc5";
const MARSHALL_INSTRUCTIONS_SHARDS: AdapterDatasetShardDefinition[] = [
  {
    id: "marshall_instructions_shard_001",
    uri: "file://.marshall/datasets/marshall-instructions/shards/shard-001",
    tokenEstimate: 18_000,
    hash: "sha256:4c47daada597e99c26571a55112167f0e21320101e631d48008d8c288693a5f6",
  },
  {
    id: "marshall_instructions_shard_002",
    uri: "file://.marshall/datasets/marshall-instructions/shards/shard-002",
    tokenEstimate: 18_000,
    hash: "sha256:0929dab33e7694eec60cdf9ed197618629cbbedf22d49e5584f39aae98c4dcaa",
  },
  {
    id: "marshall_instructions_shard_003",
    uri: "file://.marshall/datasets/marshall-instructions/shards/shard-003",
    tokenEstimate: 18_000,
    hash: "sha256:d420d91bf477d9dfa3368404453a229dde12bcd338151abcf09abc18fad3246a",
  },
  {
    id: "marshall_instructions_shard_004",
    uri: "file://.marshall/datasets/marshall-instructions/shards/shard-004",
    tokenEstimate: 18_000,
    hash: "sha256:d4ad8da0d4956b41d82fe52c47672f2720d3ac68538505469eacff01e3ac13be",
  },
] as const;

const MARSHALL_INSTRUCTIONS_DATASET: AdapterDatasetDefinition = {
  datasetId: MARSHALL_INSTRUCTIONS_DATASET_ID,
  datasetVersion: MARSHALL_INSTRUCTIONS_DATASET_VERSION,
  schema: MARSHALL_INSTRUCTIONS_SCHEMA,
  license: MARSHALL_INSTRUCTIONS_LICENSE,
  root: {
    id: "marshall_instructions_local",
    uri: "file://.marshall/datasets/marshall-instructions",
    tokenEstimate: 70_000,
    hash: MARSHALL_INSTRUCTIONS_DATASET_HASH,
  },
  shards: MARSHALL_INSTRUCTIONS_SHARDS,
};

export const DEFAULT_ADAPTER_TRAINING_CONFIG: AdapterTrainingConfig = {
  model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
  iters: 20,
  batch_size: 1,
  learning_rate: 1e-5,
  num_layers: 4,
  max_seq_length: 512,
  steps_per_report: 10,
  steps_per_eval: 20,
  val_batches: -1,
  seed: 42,
  mask_prompt: true,
  grad_checkpoint: false,
};

export function createToyTrainingJob(options: TrainingJobOptions = {}): TrainingJob {
  return TrainingJobSchema.parse({
    job_id: options.jobId ?? "job_toy_001",
    run_id: options.runId ?? "run_toy_001",
    round_id: options.roundId ?? "round_001",
    job_type: "train_toy_model",
    backend: "cpu",
    dataset_shard: {
      id: "tiny_italian_local",
      uri: "inline://tiny-italian-v1",
      token_estimate: 2_000,
      hash: "sha256:067c5c80ae7ae08a2d33868b85e149de94878dd13c7689a64561d9dd3d0751dd",
    },
    resource_requirements: options.resourceRequirements,
  });
}

export function createMlxSmokeJob(options: TrainingJobOptions = {}): TrainingJob {
  return TrainingJobSchema.parse({
    job_id: options.jobId ?? "job_mlx_smoke_001",
    run_id: options.runId ?? "run_mlx_smoke_001",
    round_id: options.roundId ?? "round_001",
    job_type: "train_mlx_smoke",
    backend: "mlx",
    dataset_shard: {
      id: "mlx_linear_smoke",
      uri: "inline://mlx-linear-smoke",
      token_estimate: 4,
      hash: "sha256:mlx-linear-smoke-v1",
    },
    resource_requirements: options.resourceRequirements,
  });
}

export function createAdapterTrainingJob(options: TrainingJobOptions = {}): TrainingJob {
  const dataset = adapterDatasetDefinition(options);
  const trainingConfig = adapterTrainingConfig(options);
  return TrainingJobSchema.parse({
    job_id: options.jobId ?? "job_adapter_001",
    run_id: options.runId ?? "run_adapter_001",
    round_id: options.roundId ?? "round_001",
    job_type: "train_adapter",
    backend: "mlx",
    dataset_shard: {
      dataset_id: dataset.datasetId,
      dataset_version: dataset.datasetVersion,
      schema: dataset.schema,
      license: dataset.license,
      id: dataset.root.id,
      uri: dataset.root.uri,
      token_estimate: dataset.root.tokenEstimate,
      hash: dataset.root.hash,
      files: dataset.root.files,
    },
    resource_requirements: options.resourceRequirements,
    training_config: trainingConfig,
  });
}

export function createAdapterTrainingShardJobs(count: number, options: TrainingJobOptions = {}): TrainingJob[] {
  const dataset = adapterDatasetDefinition(options);
  const trainingConfig = adapterTrainingConfig(options);
  if (!Number.isInteger(count) || count < 1 || count > dataset.shards.length) {
    throw new Error(`adapter shard job count must be between 1 and ${dataset.shards.length}`);
  }

  return dataset.shards.slice(0, count).map((shard, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return TrainingJobSchema.parse({
      job_id: options.jobId == null ? `job_adapter_shard_${suffix}` : `${options.jobId}_shard_${suffix}`,
      run_id: options.runId ?? "run_adapter_sharded_001",
      round_id: options.roundId ?? "round_001",
      job_type: "train_adapter",
      backend: "mlx",
      dataset_shard: {
        dataset_id: dataset.datasetId,
        dataset_version: dataset.datasetVersion,
        schema: dataset.schema,
        license: dataset.license,
        id: shard.id,
        uri: shard.uri,
        token_estimate: shard.tokenEstimate,
        hash: shard.hash,
        files: shard.files,
      },
      resource_requirements: options.resourceRequirements,
      training_config: trainingConfig,
    });
  });
}

export function defaultBackendForJob(jobType: JobType): Backend {
  return jobType === "train_mlx_smoke" || jobType === "train_adapter" || jobType === "evaluate_adapter" ? "mlx" : "cpu";
}

export function createTrainingJobs(
  jobType: TrainingJob["job_type"],
  count: number,
  options: TrainingJobOptions = {},
): TrainingJob[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`job count must be a positive integer: ${count}`);
  }
  if (jobType === "train_adapter" && count > 1) {
    return createAdapterTrainingShardJobs(count, options);
  }
  if (count === 1) {
    return [createTrainingJob(jobType, options)];
  }

  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const defaultBase = jobType === "train_mlx_smoke" ? "job_mlx_smoke" : "job_toy";
    return createTrainingJob(jobType, {
      ...options,
      jobId: options.jobId == null ? `${defaultBase}_${suffix}` : `${options.jobId}_${suffix}`,
    });
  });
}

export function createTrainingJob(jobType: TrainingJob["job_type"], options: TrainingJobOptions = {}): TrainingJob {
  if (jobType === "train_mlx_smoke") {
    return createMlxSmokeJob(options);
  }
  if (jobType === "train_adapter") {
    return createAdapterTrainingJob(options);
  }
  if (jobType === "train_toy_model") {
    return createToyTrainingJob(options);
  }
  throw new Error(`no default local job builder for ${jobType}`);
}

function adapterDatasetDefinition(options: TrainingJobOptions): AdapterDatasetDefinition {
  if (options.adapterDataset === "ag_news" || options.adapterDataset === "manifest") {
    return readAdapterDatasetManifest(options.adapterDatasetDir ?? ".marshall/datasets/ag-news");
  }
  return MARSHALL_INSTRUCTIONS_DATASET;
}

function adapterTrainingConfig(options: TrainingJobOptions): AdapterTrainingConfig {
  return {
    ...DEFAULT_ADAPTER_TRAINING_CONFIG,
    ...options.adapterTrainingConfig,
  };
}

function readAdapterDatasetManifest(datasetDir: string): AdapterDatasetDefinition {
  const manifestPath = join(datasetDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AdapterDatasetManifest;
  const shards = arrayValue(manifest.shards, `${manifestPath}: shards`).map((item, index) => {
    const shard = item as AdapterDatasetManifestShard;
    return {
      id: stringValue(shard.shard_id, `${manifestPath}: shards[${index}].shard_id`),
      uri: stringValue(shard.uri, `${manifestPath}: shards[${index}].uri`),
      tokenEstimate: numberValue(shard.token_estimate, `${manifestPath}: shards[${index}].token_estimate`),
      hash: stringValue(shard.sha256, `${manifestPath}: shards[${index}].sha256`),
      files: shard.files == null ? undefined : arrayValue(shard.files, `${manifestPath}: shards[${index}].files`).map((fileItem, fileIndex) => {
        const file = fileItem as AdapterDatasetManifestShardFile;
        return {
          path: stringValue(file.path, `${manifestPath}: shards[${index}].files[${fileIndex}].path`),
          uri: stringValue(file.uri, `${manifestPath}: shards[${index}].files[${fileIndex}].uri`),
          sha256: stringValue(file.sha256, `${manifestPath}: shards[${index}].files[${fileIndex}].sha256`),
          bytes: file.bytes == null ? undefined : nonnegativeIntegerValue(file.bytes, `${manifestPath}: shards[${index}].files[${fileIndex}].bytes`),
        };
      }),
    };
  });

  return {
    datasetId: stringValue(manifest.dataset_id, `${manifestPath}: dataset_id`),
    datasetVersion: stringValue(manifest.version, `${manifestPath}: version`),
    schema: stringValue(manifest.schema, `${manifestPath}: schema`),
    license: typeof manifest.license === "string" ? manifest.license : "unknown",
    root: {
      id: shards[0]?.files == null
        ? `${stringValue(manifest.dataset_id, `${manifestPath}: dataset_id`)}_local`
        : shards[0].id,
      uri: shards[0]?.files == null
        ? typeof manifest.root_uri === "string" ? manifest.root_uri : `file://${datasetDir}`
        : shards[0].uri,
      tokenEstimate: shards[0]?.files == null
        ? numberValue(manifest.token_estimate, `${manifestPath}: token_estimate`)
        : shards[0].tokenEstimate,
      hash: shards[0]?.files == null
        ? stringValue(manifest.root_hash, `${manifestPath}: root_hash`)
        : shards[0].hash,
      files: shards[0]?.files,
    },
    shards,
  };
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid manifest field ${field}`);
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid manifest field ${field}`);
  }
  return value;
}

function nonnegativeIntegerValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid manifest field ${field}`);
  }
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`invalid manifest field ${field}`);
  }
  return value;
}
