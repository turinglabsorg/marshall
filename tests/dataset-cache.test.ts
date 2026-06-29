import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashDatasetPath, prepareDatasetShard } from "../src/dataset-cache.js";
import { createTrainingJobs } from "../src/jobs.js";

describe("dataset cache", () => {
  it("hashes and caches a sharded dataset directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-dataset-cache-test-"));
    try {
      const [job] = createTrainingJobs("train_adapter", 4, {
        jobId: "job_cache_test",
        runId: "run_cache_test",
      });
      const sourcePath = "examples/datasets/marshall-instructions/shards/shard-001";

      expect(await hashDatasetPath(sourcePath)).toBe(job.dataset_shard.hash);

      const first = await prepareDatasetShard(job.dataset_shard, {
        projectRoot: process.cwd(),
        cacheRoot: join(tempDir, "cache"),
      });
      expect(first.cacheHit).toBe(false);
      expect(await hashDatasetPath(first.path)).toBe(job.dataset_shard.hash);

      const second = await prepareDatasetShard(job.dataset_shard, {
        projectRoot: process.cwd(),
        cacheRoot: join(tempDir, "cache"),
      });
      expect(second.cacheHit).toBe(true);
      expect(second.path).toBe(first.path);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
