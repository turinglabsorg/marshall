import { z } from "zod";

export const JobTypeSchema = z.enum([
  "train_toy_model",
  "train_mlx_smoke",
  "train_adapter",
  "evaluate_model",
  "tokenize_dataset",
  "clean_dataset",
  "benchmark_inference",
]);

export const BackendSchema = z.enum(["mlx", "cuda", "cpu"]);

export const WorkerRegistrationSchema = z.object({
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  public_key: z.string().min(1),
  backend: BackendSchema,
  device_family: z.string().min(1),
  memory_gb: z.number().positive(),
  supported_jobs: z.array(JobTypeSchema).min(1),
  benchmarks: z.object({
    tokens_per_second: z.number().nonnegative(),
  }),
});

export const WorkerRegistrationResponseSchema = z.object({
  accepted: z.boolean(),
  worker_id: z.string().min(1),
  peer_id: z.string().min(1),
});

export const WorkerHeartbeatSchema = z.object({
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  status: z.enum(["idle", "working"]),
  timestamp: z.string().min(1),
});

export const JobClaimSchema = z.object({
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  job_type: JobTypeSchema,
  backend: BackendSchema,
  max_tokens: z.number().positive(),
});

export const TrainingJobSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  job_type: z.enum(["train_toy_model", "train_mlx_smoke", "train_adapter"]),
  backend: BackendSchema,
  dataset_shard: z.object({
    id: z.string().min(1),
    uri: z.string().min(1),
    token_estimate: z.number().positive(),
    hash: z.string().min(1),
  }),
});

export const JobClaimResponseSchema = z.object({
  accepted: z.boolean(),
  job: TrainingJobSchema.nullable(),
  reason: z.string().optional(),
});

export const JobStatusSchema = z.object({
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  job_id: z.string().min(1),
  status: z.enum(["claimed", "running", "completed", "failed"]),
  message: z.string().optional(),
});

export const ArtifactManifestSchema = z.object({
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  job_id: z.string().min(1),
  artifact_type: z.enum(["toy_language_model", "mlx_smoke_result", "lora_adapter"]),
  artifact_uri: z.string().min(1),
  artifact_hash: z.string().min(1),
  config_hash: z.string().min(1),
  created_at: z.string().min(1),
  metrics_uri: z.string().min(1).optional(),
});

export const TrainingArtifactManifestSchema = ArtifactManifestSchema.omit({
  peer_id: true,
  worker_id: true,
});

export const ToyTrainingMetricsSchema = z.object({
  job_id: z.string().min(1),
  dataset: z.string().min(1),
  examples: z.number().int().positive(),
  tokens: z.number().int().positive(),
  vocab_size: z.number().int().positive(),
  epochs: z.number().int().positive(),
  learning_rate: z.number().positive(),
  loss_start: z.number().positive(),
  loss_end: z.number().positive(),
  loss_delta: z.number(),
});

export const MlxSmokeMetricsSchema = z.object({
  backend: z.literal("mlx"),
  device: z.string().min(1),
  weight: z.number(),
  loss_start: z.number().nonnegative(),
  loss_end: z.number().nonnegative(),
  loss_delta: z.number(),
});

export const AckSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
});

export type JobType = z.infer<typeof JobTypeSchema>;
export type Backend = z.infer<typeof BackendSchema>;
export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>;
export type WorkerRegistrationResponse = z.infer<typeof WorkerRegistrationResponseSchema>;
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
export type JobClaim = z.infer<typeof JobClaimSchema>;
export type TrainingJob = z.infer<typeof TrainingJobSchema>;
export type JobClaimResponse = z.infer<typeof JobClaimResponseSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type TrainingArtifactManifest = z.infer<typeof TrainingArtifactManifestSchema>;
export type ToyTrainingMetrics = z.infer<typeof ToyTrainingMetricsSchema>;
export type MlxSmokeMetrics = z.infer<typeof MlxSmokeMetricsSchema>;
export type Ack = z.infer<typeof AckSchema>;
