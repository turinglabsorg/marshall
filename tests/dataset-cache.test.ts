import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hashDatasetPath, prepareDatasetShard } from "../src/dataset-cache.js";
import { createTrainingJob } from "../src/jobs.js";

describe("dataset cache", () => {
  it("hashes a full split dataset in manifest order", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-dataset-hash-test-"));
    try {
      const sourcePath = join(tempDir, "source");
      await writeSplitDataset(sourcePath);

      expect(await hashDatasetPath(sourcePath)).toBe(hashSplitFiles(["train.jsonl", "valid.jsonl", "test.jsonl", "eval.jsonl"]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("hashes and caches a sharded dataset directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-dataset-cache-test-"));
    try {
      const sourcePath = join(tempDir, "source-shard");
      await writeSplitDataset(sourcePath, { test: false, eval: false });
      const shardHash = await hashDatasetPath(sourcePath);
      const datasetShard = {
        id: "local_shard_001",
        uri: pathToFileURL(sourcePath).toString(),
        token_estimate: 100,
        hash: shardHash,
      };

      const first = await prepareDatasetShard(datasetShard, {
        projectRoot: process.cwd(),
        cacheRoot: join(tempDir, "cache"),
      });
      expect(first.cacheHit).toBe(false);
      expect(await hashDatasetPath(first.path)).toBe(shardHash);

      const second = await prepareDatasetShard(datasetShard, {
        projectRoot: process.cwd(),
        cacheRoot: join(tempDir, "cache"),
      });
      expect(second.cacheHit).toBe(true);
      expect(second.path).toBe(first.path);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("hashes a cached single eval JSONL like the source file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-eval-cache-test-"));
    try {
      const sourcePath = join(tempDir, "eval.jsonl");
      const cachePath = join(tempDir, "cache");
      await writeFile(sourcePath, "{\"id\":\"eval-001\",\"text\":\"local eval row\"}\n", "utf8");
      await mkdir(cachePath, { recursive: true });
      await cp(sourcePath, join(cachePath, "eval.jsonl"));

      expect(await hashDatasetPath(cachePath)).toBe(await hashDatasetPath(sourcePath));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prepares a single eval JSONL as a file path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-eval-prepare-test-"));
    try {
      const sourcePath = join(tempDir, "eval.jsonl");
      await writeFile(sourcePath, "{\"id\":\"eval-001\",\"text\":\"local eval row\"}\n", "utf8");
      const prepared = await prepareDatasetShard({
        id: "marshall_eval_file",
        uri: pathToFileURL(sourcePath).toString(),
        token_estimate: 100,
        hash: await hashDatasetPath(sourcePath),
      }, {
        projectRoot: process.cwd(),
        cacheRoot: join(tempDir, "cache"),
      });

      expect(prepared.path.endsWith("eval.jsonl")).toBe(true);
      expect(await hashDatasetPath(prepared.path)).toBe(prepared.hash);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes the built-in toy dataset into the local cache", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-inline-cache-test-"));
    try {
      const job = createTrainingJob("train_toy_model");
      const prepared = await prepareDatasetShard(job.dataset_shard, {
        projectRoot: process.cwd(),
        cacheRoot: join(tempDir, "cache"),
      });

      expect(prepared.cacheHit).toBe(false);
      expect(prepared.path.endsWith("tiny-italian.jsonl")).toBe(true);
      expect(await hashDatasetPath(prepared.path)).toBe(job.dataset_shard.hash);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeSplitDataset(
  root: string,
  options: { test?: boolean; eval?: boolean } = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "train.jsonl"), SPLIT_FILES["train.jsonl"], "utf8");
  await writeFile(join(root, "valid.jsonl"), SPLIT_FILES["valid.jsonl"], "utf8");
  if (options.test !== false) {
    await writeFile(join(root, "test.jsonl"), SPLIT_FILES["test.jsonl"], "utf8");
  }
  if (options.eval !== false) {
    await writeFile(join(root, "eval.jsonl"), SPLIT_FILES["eval.jsonl"], "utf8");
  }
}

const SPLIT_FILES: Record<string, string> = {
  "train.jsonl": "{\"text\":\"train row one\"}\n{\"text\":\"train row two\"}\n",
  "valid.jsonl": "{\"text\":\"valid row\"}\n",
  "test.jsonl": "{\"text\":\"test row\"}\n",
  "eval.jsonl": "{\"text\":\"eval row\"}\n",
};

function hashSplitFiles(names: string[]): string {
  const digest = createHash("sha256");
  for (const name of names) {
    const content = SPLIT_FILES[name];
    digest.update(`file\0${name}\0${Buffer.byteLength(content, "utf8")}\0`);
    digest.update(content, "utf8");
  }
  return `sha256:${digest.digest("hex")}`;
}
