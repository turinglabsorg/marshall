import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hashDatasetPath } from "../src/dataset-cache.js";
import type { TrainingJob } from "../src/schemas.js";
import { runMlxLoraTraining } from "../src/training-runner.js";

describe("training runner", () => {
  it("passes a dataset directory to MLX LoRA even when the cache has one train file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-lora-runner-test-"));
    try {
      const projectRoot = join(tempDir, "project");
      const datasetRoot = join(tempDir, "source");
      const cacheRoot = join(tempDir, "cache");
      const outputRoot = join(tempDir, "outputs");
      const trainPath = join(datasetRoot, "remote-train.jsonl");
      const fakeScriptPath = join(projectRoot, "training", "mlx_lora_smoke.py");

      await mkdir(datasetRoot, { recursive: true });
      await mkdir(join(projectRoot, "training"), { recursive: true });
      await writeFile(trainPath, "{\"text\":\"train row\"}\n", "utf8");
      await writeFile(fakeScriptPath, fakeMlxLoraScript(), "utf8");

      const job: TrainingJob = {
        job_id: "job_lora_single_file",
        run_id: "run_lora_single_file",
        round_id: "round_001",
        job_type: "train_adapter",
        backend: "mlx",
        dataset_shard: {
          id: "single_train_file",
          uri: "https://datasets.example.invalid/shards/single-train-file",
          token_estimate: 10,
          hash: await hashDatasetPath(trainPath),
          files: [
            {
              path: "train.jsonl",
              uri: pathToFileURL(trainPath).toString(),
              sha256: await hashDatasetPath(trainPath),
              bytes: Buffer.byteLength("{\"text\":\"train row\"}\n", "utf8"),
            },
          ],
        },
      };

      const result = await runMlxLoraTraining(job, {
        projectRoot,
        outputRoot,
        datasetCacheRoot: cacheRoot,
        pythonBin: process.execPath,
      });

      const datasetInfo = await stat(result.metrics.dataset);
      expect(datasetInfo.isDirectory()).toBe(true);
      expect(result.metrics.dataset).toBe(join(cacheRoot, job.dataset_shard.hash.replace("sha256:", "")));
      expect(result.metrics.train_examples).toBe(1);
      expect(result.manifest.artifact_type).toBe("lora_adapter");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function fakeMlxLoraScript(): string {
  return `
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const args = parseArgs(process.argv.slice(2));
const datasetDir = args["dataset-dir"];
const outputDir = args["output-dir"];
const adapterDir = join(outputDir, "adapters");
const trainPath = join(datasetDir, "train.jsonl");
if (!statSync(datasetDir).isDirectory()) {
  throw new Error("dataset-dir is not a directory");
}
readFileSync(trainPath, "utf8");
mkdirSync(adapterDir, { recursive: true });
writeFileSync(join(adapterDir, "adapter_config.json"), "{}\\n", "utf8");
writeFileSync(join(outputDir, "stdout.log"), "ok\\n", "utf8");
writeFileSync(join(outputDir, "stderr.log"), "\\n", "utf8");
writeFileSync(join(outputDir, "metrics.json"), JSON.stringify({
  job_id: args["job-id"],
  run_id: args["run-id"],
  round_id: args["round-id"],
  backend: "mlx",
  device: "test",
  model: args.model,
  dataset: datasetDir,
  adapter_path: adapterDir,
  train_examples: 1,
  valid_examples: 0,
  iters: Number(args.iters),
  batch_size: Number(args["batch-size"]),
  learning_rate: Number(args["learning-rate"]),
  num_layers: Number(args["num-layers"]),
  max_seq_length: Number(args["max-seq-length"]),
  steps_per_report: Number(args["steps-per-report"]),
  steps_per_eval: Number(args["steps-per-eval"]),
  val_batches: Number(args["val-batches"]),
  seed: Number(args.seed),
  mask_prompt: args["mask-prompt"] === "true",
  grad_checkpoint: args["grad-checkpoint"] === "true",
  artifact_files: [{
    path: "adapter_config.json",
    bytes: 3,
    sha256: "sha256:" + createHash("sha256").update("{}\\n").digest("hex"),
  }],
  stdout_log: join(outputDir, "stdout.log"),
  stderr_log: join(outputDir, "stderr.log"),
}, null, 2) + "\\n", "utf8");

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next == null || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
`;
}
