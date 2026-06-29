import { describe, expect, it } from "vitest";
import { createTrainingJob, defaultBackendForJob } from "../src/jobs.js";

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
});
