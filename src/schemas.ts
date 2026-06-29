import { z } from "zod";

export const JobTypeSchema = z.enum([
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

export const TrainAdapterJobSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  job_type: z.literal("train_adapter"),
  backend: z.literal("mlx"),
  dataset_shard: z.object({
    id: z.string().min(1),
    token_estimate: z.number().positive(),
    hash: z.string().min(1),
  }),
});

export const JobClaimResponseSchema = z.object({
  accepted: z.boolean(),
  job: TrainAdapterJobSchema.nullable(),
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
  artifact_type: z.literal("lora_adapter"),
  artifact_uri: z.string().min(1),
  artifact_hash: z.string().min(1),
  config_hash: z.string().min(1),
  created_at: z.string().min(1),
});

export const AckSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
});

export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>;
export type WorkerRegistrationResponse = z.infer<typeof WorkerRegistrationResponseSchema>;
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
export type JobClaim = z.infer<typeof JobClaimSchema>;
export type TrainAdapterJob = z.infer<typeof TrainAdapterJobSchema>;
export type JobClaimResponse = z.infer<typeof JobClaimResponseSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type Ack = z.infer<typeof AckSchema>;
