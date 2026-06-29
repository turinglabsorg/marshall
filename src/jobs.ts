import { TrainingJobSchema, type Backend, type TrainingJob } from "./schemas.js";

export interface TrainingJobOptions {
  jobId?: string;
  runId?: string;
  roundId?: string;
}

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
      token_estimate: 8_000,
      hash: "sha256:633b1de13fa093d1ea4b263f9a356835a764d0532ec900ee701bbc764ea54e88",
    },
  });
}

export function defaultBackendForJob(jobType: TrainingJob["job_type"]): Backend {
  return jobType === "train_mlx_smoke" || jobType === "train_adapter" ? "mlx" : "cpu";
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
