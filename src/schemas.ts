import { z } from "zod";

export const JobTypeSchema = z.enum([
  "train_toy_model",
  "train_mlx_smoke",
  "train_adapter",
  "evaluate_adapter",
  "validate_artifact",
  "evaluate_model",
  "tokenize_dataset",
  "clean_dataset",
  "benchmark_inference",
]);

export const BackendSchema = z.enum(["mlx", "cuda", "cpu"]);

export const WorkerRegistrationSchema = z.object({
  auth_token: z.string().min(1).optional(),
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
  auth_token: z.string().min(1).optional(),
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  status: z.enum(["idle", "working"]),
  job_id: z.string().min(1).optional(),
  timestamp: z.string().min(1),
  lease_seconds: z.number().int().positive().optional(),
  progress_percent: z.number().min(0).max(100).optional(),
  progress_label: z.string().min(1).optional(),
  work_units_done: z.number().nonnegative().optional(),
  work_units_total: z.number().positive().optional(),
  throughput_units_per_second: z.number().nonnegative().optional(),
  throughput_label: z.string().min(1).optional(),
});

export const JobClaimSchema = z.object({
  auth_token: z.string().min(1).optional(),
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  job_type: JobTypeSchema,
  backend: BackendSchema,
  max_tokens: z.number().positive(),
});

export const DatasetShardSchema = z.object({
  dataset_id: z.string().min(1).optional(),
  dataset_version: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
  id: z.string().min(1),
  uri: z.string().min(1),
  token_estimate: z.number().positive(),
  hash: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    uri: z.string().min(1),
    sha256: z.string().min(1),
    bytes: z.number().int().nonnegative().optional(),
  })).optional(),
});

export const ResourceRequirementsSchema = z.object({
  min_memory_gb: z.number().positive().optional(),
});

export const TrainingJobSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  job_type: z.enum(["train_toy_model", "train_mlx_smoke", "train_adapter"]),
  backend: BackendSchema,
  dataset_shard: DatasetShardSchema,
  resource_requirements: ResourceRequirementsSchema.optional(),
  training_config: z.object({
    model: z.string().min(1),
    iters: z.number().int().positive(),
    batch_size: z.number().int().positive(),
    learning_rate: z.number().positive(),
    num_layers: z.number().int().positive(),
    max_seq_length: z.number().int().positive(),
    steps_per_report: z.number().int().positive(),
    steps_per_eval: z.number().int().positive(),
    val_batches: z.number().int(),
    seed: z.number().int(),
    mask_prompt: z.boolean(),
    grad_checkpoint: z.boolean(),
  }).optional(),
});

export const AdapterReferenceSchema = z.object({
  adapter_id: z.string().min(1),
  artifact_uri: z.string().min(1),
  artifact_hash: z.string().min(1),
  config_hash: z.string().min(1).optional(),
  source_job_id: z.string().min(1).optional(),
});

export const AdapterEvaluationJobSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  job_type: z.literal("evaluate_adapter"),
  backend: BackendSchema,
  resource_requirements: ResourceRequirementsSchema.optional(),
  eval_kind: z.enum(["ag_news", "instruction_terms"]),
  model: z.string().min(1),
  adapter: AdapterReferenceSchema,
  eval_shard: DatasetShardSchema,
  labels: z.array(z.string().min(1)).min(1).optional(),
  max_examples: z.number().int().positive(),
  max_tokens: z.number().int().positive(),
});

export const ArtifactValidationVerdictSchema = z.enum(["accepted", "poor", "rejected", "malicious"]);

export const ArtifactValidationTargetSchema = z.object({
  job_id: z.string().min(1),
  worker_id: z.string().min(1),
  peer_id: z.string().min(1).optional(),
  artifact_type: z.enum(["toy_language_model", "mlx_smoke_result", "lora_adapter", "adapter_evaluation", "optimized_model_package"]),
  artifact_uri: z.string().min(1),
  artifact_hash: z.string().min(1),
  config_hash: z.string().min(1).optional(),
  metrics_uri: z.string().min(1).optional(),
});

export const ArtifactValidationPolicySchema = z.object({
  min_accuracy: z.number().min(0).max(1).optional(),
  max_invalid_rate: z.number().min(0).max(1).optional(),
  min_examples: z.number().int().positive().optional(),
  quorum: z.number().int().positive().optional(),
});

export const ArtifactValidationJobSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  job_type: z.literal("validate_artifact"),
  backend: BackendSchema,
  resource_requirements: ResourceRequirementsSchema.optional(),
  target: ArtifactValidationTargetSchema,
  policy: ArtifactValidationPolicySchema.optional(),
});

export const MarshallJobSchema = z.union([
  TrainingJobSchema,
  AdapterEvaluationJobSchema,
  ArtifactValidationJobSchema,
]);

export const AdapterEvaluationMetricsSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  adapter_id: z.string().min(1),
  adapter_artifact_hash: z.string().min(1),
  eval_shard_id: z.string().min(1),
  eval_shard_hash: z.string().min(1),
  eval_kind: z.enum(["ag_news", "instruction_terms"]),
  model: z.string().min(1),
  adapter_path: z.string().min(1).nullable(),
  eval_file: z.string().min(1),
  examples: z.number().int().positive(),
  correct: z.number().int().nonnegative(),
  accuracy: z.number().nonnegative(),
  invalid: z.number().int().nonnegative(),
  invalid_rate: z.number().nonnegative(),
  labels: z.array(z.string().min(1)).min(1),
  results: z.array(z.object({
    id: z.string().min(1),
    expected_label: z.string().min(1),
    predicted_label: z.string().min(1).nullable(),
    correct: z.boolean(),
    output: z.string(),
  })),
});

export const JobClaimResponseSchema = z.object({
  accepted: z.boolean(),
  job: MarshallJobSchema.nullable(),
  reason: z.string().optional(),
});

export const JobStatusSchema = z.object({
  auth_token: z.string().min(1).optional(),
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  job_id: z.string().min(1),
  status: z.enum(["claimed", "running", "completed", "failed"]),
  message: z.string().optional(),
});

export const ArtifactManifestSchema = z.object({
  auth_token: z.string().min(1).optional(),
  peer_id: z.string().min(1),
  worker_id: z.string().min(1),
  job_id: z.string().min(1),
  artifact_type: z.enum(["toy_language_model", "mlx_smoke_result", "lora_adapter", "adapter_evaluation", "artifact_validation", "optimized_model_package"]),
  artifact_uri: z.string().min(1),
  artifact_hash: z.string().min(1),
  config_hash: z.string().min(1),
  created_at: z.string().min(1),
  metrics_uri: z.string().min(1).optional(),
  validation: z.object({
    target_job_id: z.string().min(1),
    target_worker_id: z.string().min(1),
    verdict: ArtifactValidationVerdictSchema,
    reason: z.string().optional(),
    quorum: z.number().int().positive().optional(),
  }).optional(),
});

export const InferenceRequestSchema = z.object({
  type: z.literal("marshall_inference_request").optional(),
  request_id: z.string().min(1).optional(),
  prompt: z.string().min(1),
  system_prompt: z.string().min(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().finite().optional(),
});

export const InferenceHelloRequestSchema = z.object({
  type: z.literal("marshall_inference_hello_request").optional(),
});

export const InferenceHelloResponseSchema = z.discriminatedUnion("accepted", [
  z.object({
    type: z.literal("marshall_inference_hello_response"),
    accepted: z.literal(true),
    peer_id: z.string().min(1),
    worker_id: z.string().min(1).optional(),
    model: z.string().min(1),
    adapter_id: z.string().min(1),
    adapter_hash: z.string().min(1),
    max_tokens: z.number().int().positive(),
    temperature: z.number().finite(),
    uptime_ms: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("marshall_inference_hello_response"),
    accepted: z.literal(false),
    peer_id: z.string().min(1).optional(),
    worker_id: z.string().min(1).optional(),
    error: z.string().optional(),
  }),
]);

export const InferenceResponseSchema = z.object({
  type: z.literal("marshall_inference_response"),
  accepted: z.boolean(),
  peer_id: z.string().min(1),
  worker_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  adapter_id: z.string().min(1).optional(),
  adapter_hash: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  text: z.string().optional(),
  raw_text: z.string().optional(),
  elapsed_ms: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const TrainingArtifactManifestSchema = ArtifactManifestSchema.omit({
  peer_id: true,
  worker_id: true,
});

export const ArtifactBundleFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
});

export const ArtifactFetchManifestRequestSchema = z.object({
  auth_token: z.string().min(1).optional(),
  request_type: z.literal("manifest"),
  job_id: z.string().min(1),
  artifact_hash: z.string().min(1),
});

export const ArtifactFetchChunkRequestSchema = z.object({
  auth_token: z.string().min(1).optional(),
  request_type: z.literal("chunk"),
  job_id: z.string().min(1),
  artifact_hash: z.string().min(1),
  path: z.string().min(1),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});

export const ArtifactFetchRequestSchema = z.discriminatedUnion("request_type", [
  ArtifactFetchManifestRequestSchema,
  ArtifactFetchChunkRequestSchema,
]);

export const ArtifactFetchManifestResponseSchema = z.discriminatedUnion("accepted", [
  z.object({
    response_type: z.literal("manifest"),
    accepted: z.literal(true),
    job_id: z.string().min(1),
    artifact_hash: z.string().min(1),
    artifact_path: z.string().min(1),
    metrics_path: z.string().min(1).optional(),
    manifest: ArtifactManifestSchema,
    files: z.array(ArtifactBundleFileSchema),
  }),
  z.object({
    response_type: z.literal("manifest"),
    accepted: z.literal(false),
    reason: z.string().min(1).optional(),
  }),
]);

export const ArtifactFetchChunkResponseSchema = z.discriminatedUnion("accepted", [
  z.object({
    response_type: z.literal("chunk"),
    accepted: z.literal(true),
    job_id: z.string().min(1),
    artifact_hash: z.string().min(1),
    path: z.string().min(1),
    offset: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    chunk_hash: z.string().min(1),
    data_base64: z.string(),
  }),
  z.object({
    response_type: z.literal("chunk"),
    accepted: z.literal(false),
    reason: z.string().min(1).optional(),
  }),
]);

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

export const MlxLoraMetricsSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  backend: z.literal("mlx"),
  device: z.string().min(1),
  model: z.string().min(1),
  dataset: z.string().min(1),
  adapter_path: z.string().min(1),
  train_examples: z.number().int().positive(),
  valid_examples: z.number().int().nonnegative(),
  iters: z.number().int().positive(),
  batch_size: z.number().int().positive(),
  learning_rate: z.number().positive(),
  num_layers: z.number().int().positive(),
  max_seq_length: z.number().int().positive(),
  steps_per_report: z.number().int().positive(),
  steps_per_eval: z.number().int().positive(),
  val_batches: z.number().int(),
  seed: z.number().int(),
  mask_prompt: z.boolean(),
  grad_checkpoint: z.boolean(),
  train_loss_start: z.number().nonnegative().optional(),
  train_loss_end: z.number().nonnegative().optional(),
  train_loss_delta: z.number().optional(),
  val_loss_start: z.number().nonnegative().optional(),
  val_loss_end: z.number().nonnegative().optional(),
  val_loss_delta: z.number().optional(),
  artifact_files: z.array(z.object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  })).min(1),
  stdout_log: z.string().min(1),
  stderr_log: z.string().min(1),
});

export const ArtifactValidationMetricsSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  round_id: z.string().min(1),
  target_job_id: z.string().min(1),
  target_worker_id: z.string().min(1),
  target_artifact_type: z.string().min(1),
  target_artifact_hash: z.string().min(1),
  verdict: ArtifactValidationVerdictSchema,
  reason: z.string().min(1),
  checks: z.array(z.object({
    name: z.string().min(1),
    passed: z.boolean(),
    detail: z.string().optional(),
  })),
  observed: z.object({
    accuracy: z.number().optional(),
    invalid_rate: z.number().optional(),
    examples: z.number().int().optional(),
  }).optional(),
  policy: ArtifactValidationPolicySchema,
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
export type DatasetShard = z.infer<typeof DatasetShardSchema>;
export type ResourceRequirements = z.infer<typeof ResourceRequirementsSchema>;
export type TrainingJob = z.infer<typeof TrainingJobSchema>;
export type AdapterReference = z.infer<typeof AdapterReferenceSchema>;
export type AdapterEvaluationJob = z.infer<typeof AdapterEvaluationJobSchema>;
export type ArtifactValidationVerdict = z.infer<typeof ArtifactValidationVerdictSchema>;
export type ArtifactValidationTarget = z.infer<typeof ArtifactValidationTargetSchema>;
export type ArtifactValidationPolicy = z.infer<typeof ArtifactValidationPolicySchema>;
export type ArtifactValidationJob = z.infer<typeof ArtifactValidationJobSchema>;
export type MarshallJob = z.infer<typeof MarshallJobSchema>;
export type JobClaimResponse = z.infer<typeof JobClaimResponseSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type TrainingArtifactManifest = z.infer<typeof TrainingArtifactManifestSchema>;
export type ArtifactBundleFile = z.infer<typeof ArtifactBundleFileSchema>;
export type ArtifactFetchManifestRequest = z.infer<typeof ArtifactFetchManifestRequestSchema>;
export type ArtifactFetchChunkRequest = z.infer<typeof ArtifactFetchChunkRequestSchema>;
export type ArtifactFetchRequest = z.infer<typeof ArtifactFetchRequestSchema>;
export type ArtifactFetchManifestResponse = z.infer<typeof ArtifactFetchManifestResponseSchema>;
export type ArtifactFetchChunkResponse = z.infer<typeof ArtifactFetchChunkResponseSchema>;
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;
export type InferenceHelloRequest = z.infer<typeof InferenceHelloRequestSchema>;
export type InferenceHelloResponse = z.infer<typeof InferenceHelloResponseSchema>;
export type InferenceResponse = z.infer<typeof InferenceResponseSchema>;
export type ToyTrainingMetrics = z.infer<typeof ToyTrainingMetricsSchema>;
export type MlxSmokeMetrics = z.infer<typeof MlxSmokeMetricsSchema>;
export type MlxLoraMetrics = z.infer<typeof MlxLoraMetricsSchema>;
export type AdapterEvaluationMetrics = z.infer<typeof AdapterEvaluationMetricsSchema>;
export type ArtifactValidationMetrics = z.infer<typeof ArtifactValidationMetricsSchema>;
export type Ack = z.infer<typeof AckSchema>;
