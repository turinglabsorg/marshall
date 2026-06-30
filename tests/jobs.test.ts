import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        uri: "file://.marshall/datasets/marshall-instructions",
      },
    });
    expect(defaultBackendForJob("train_adapter")).toBe("mlx");
    expect(defaultBackendForJob("validate_artifact")).toBe("cpu");
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

  it("creates adapter jobs from a local AG News manifest", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-ag-news-manifest-test-"));
    try {
      await mkdir(join(tempDir, "shards", "shard-001"), { recursive: true });
      await mkdir(join(tempDir, "shards", "shard-002"), { recursive: true });
      await writeFile(join(tempDir, "manifest.json"), JSON.stringify({
        dataset_id: "ag-news-classification-v1",
        version: "2026-06-29",
        schema: "mlx-chat-jsonl",
        license: "external-local-test",
        root_uri: "file://.marshall/datasets/ag-news",
        root_hash: "sha256:root",
        token_estimate: 1000,
        shards: [
          {
            shard_id: "ag_news_shard_001",
            uri: "file://.marshall/datasets/ag-news/shards/shard-001",
            sha256: "sha256:one",
            token_estimate: 500,
          },
          {
            shard_id: "ag_news_shard_002",
            uri: "file://.marshall/datasets/ag-news/shards/shard-002",
            sha256: "sha256:two",
            token_estimate: 500,
          },
        ],
      }));

      const jobs = createTrainingJobs("train_adapter", 2, {
        jobId: "job_ag_news",
        runId: "run_ag_news",
        adapterDataset: "ag_news",
        adapterDatasetDir: tempDir,
      });

      expect(jobs.map((job) => job.dataset_shard.id)).toEqual(["ag_news_shard_001", "ag_news_shard_002"]);
      expect(jobs.map((job) => job.dataset_shard.dataset_id)).toEqual([
        "ag-news-classification-v1",
        "ag-news-classification-v1",
      ]);
      expect(jobs.map((job) => job.dataset_shard.hash)).toEqual(["sha256:one", "sha256:two"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
