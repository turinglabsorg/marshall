import { describe, expect, it } from "vitest";
import { createTrainingJob, createTrainingJobs, defaultBackendForJob } from "../src/jobs.js";

describe("training job builders", () => {
  it("creates a tiny MLX LoRA adapter job", () => {
    const job = createTrainingJob("train_adapter", {
      jobId: "job_adapter_test",
      runId: "run_adapter_test",
      roundId: "round_test",
    });

    expect(job).toMatchObject({
      job_id: "job_adapter_test",
      run_id: "run_adapter_test",
      round_id: "round_test",
      job_type: "train_adapter",
      backend: "mlx",
      dataset_shard: {
        id: "marshall_instructions_local",
        uri: "file://examples/datasets/marshall-instructions",
      },
    });
    expect(defaultBackendForJob("train_adapter")).toBe("mlx");
  });

  it("creates sharded MLX adapter jobs for multi-worker runs", () => {
    const jobs = createTrainingJobs("train_adapter", 4, {
      jobId: "job_adapter_multi",
      runId: "run_adapter_multi",
      roundId: "round_multi",
    });

    expect(jobs.map((job) => job.job_id)).toEqual([
      "job_adapter_multi_shard_001",
      "job_adapter_multi_shard_002",
      "job_adapter_multi_shard_003",
      "job_adapter_multi_shard_004",
    ]);
    expect(jobs.map((job) => job.dataset_shard.id)).toEqual([
      "marshall_instructions_shard_001",
      "marshall_instructions_shard_002",
      "marshall_instructions_shard_003",
      "marshall_instructions_shard_004",
    ]);
    expect(new Set(jobs.map((job) => job.dataset_shard.uri)).size).toBe(4);
    expect(jobs.every((job) => job.backend === "mlx")).toBe(true);
  });
});
