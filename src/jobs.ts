import { TrainingJobSchema, type Backend, type TrainingJob } from "./schemas.js";

export interface TrainingJobOptions {
  jobId?: string;
  runId?: string;
  roundId?: string;
}

const MARSHALL_INSTRUCTIONS_DATASET_HASH = "sha256:49dc3107aaa27c18390de86fcfbc7b4ee633bbbcd0f2051e9c6f0bca4d7d543f";
const MARSHALL_INSTRUCTIONS_SHARDS = [
  {
    id: "marshall_instructions_shard_001",
    uri: "file://examples/datasets/marshall-instructions/shards/shard-001",
    tokenEstimate: 18_000,
    hash: "sha256:dff77f2162331f5198fd392ff10bc6fe270fa128398f36683a0bf049005d22cd",
  },
  {
    id: "marshall_instructions_shard_002",
    uri: "file://examples/datasets/marshall-instructions/shards/shard-002",
    tokenEstimate: 18_000,
    hash: "sha256:e36506bf01d00268b259303633f87807f316190fb2402692f0cac7b934217eee",
  },
  {
    id: "marshall_instructions_shard_003",
    uri: "file://examples/datasets/marshall-instructions/shards/shard-003",
    tokenEstimate: 18_000,
    hash: "sha256:2988092a67c68e618db1925b54dfa1ffaf1f402ce5b3c5475df99eba7845cc5b",
  },
  {
    id: "marshall_instructions_shard_004",
    uri: "file://examples/datasets/marshall-instructions/shards/shard-004",
    tokenEstimate: 18_000,
    hash: "sha256:3ae7a6b6a7f5fbf9934ea5603f0fce8a090b0e09aaa9ddf38c478efc86b45e35",
  },
] as const;

export function createToyTrainingJob(options: TrainingJobOptions = {}): TrainingJob {
  return TrainingJobSchema.parse({
    job_id: options.jobId ?? "job_toy_001",
    run_id: options.runId ?? "run_toy_001",
    round_id: options.roundId ?? "round_001",
    job_type: "train_toy_model",
    backend: "cpu",
    dataset_shard: {
      id: "tiny_italian_local",
      uri: "file://examples/datasets/tiny-italian.jsonl",
      token_estimate: 2_000,
      hash: "sha256:067c5c80ae7ae08a2d33868b85e149de94878dd13c7689a64561d9dd3d0751dd",
    },
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
  });
}

export function createAdapterTrainingJob(options: TrainingJobOptions = {}): TrainingJob {
  return TrainingJobSchema.parse({
    job_id: options.jobId ?? "job_adapter_001",
    run_id: options.runId ?? "run_adapter_001",
    round_id: options.roundId ?? "round_001",
    job_type: "train_adapter",
    backend: "mlx",
    dataset_shard: {
      id: "marshall_instructions_local",
      uri: "file://examples/datasets/marshall-instructions",
      token_estimate: 70_000,
      hash: MARSHALL_INSTRUCTIONS_DATASET_HASH,
    },
  });
}

export function createAdapterTrainingShardJobs(count: number, options: TrainingJobOptions = {}): TrainingJob[] {
  if (!Number.isInteger(count) || count < 1 || count > MARSHALL_INSTRUCTIONS_SHARDS.length) {
    throw new Error(`adapter shard job count must be between 1 and ${MARSHALL_INSTRUCTIONS_SHARDS.length}`);
  }

  return MARSHALL_INSTRUCTIONS_SHARDS.slice(0, count).map((shard, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return TrainingJobSchema.parse({
      job_id: options.jobId == null ? `job_adapter_shard_${suffix}` : `${options.jobId}_shard_${suffix}`,
      run_id: options.runId ?? "run_adapter_sharded_001",
      round_id: options.roundId ?? "round_001",
      job_type: "train_adapter",
      backend: "mlx",
      dataset_shard: {
        id: shard.id,
        uri: shard.uri,
        token_estimate: shard.tokenEstimate,
        hash: shard.hash,
      },
    });
  });
}

export function defaultBackendForJob(jobType: TrainingJob["job_type"]): Backend {
  return jobType === "train_mlx_smoke" || jobType === "train_adapter" ? "mlx" : "cpu";
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
      jobId: options.jobId == null ? `${defaultBase}_${suffix}` : `${options.jobId}_${suffix}`,
      runId: options.runId,
      roundId: options.roundId,
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
