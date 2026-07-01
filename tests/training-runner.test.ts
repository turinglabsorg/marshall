import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hashDatasetPath } from "../src/dataset-cache.js";
import { AdapterEvaluationJobSchema, type AdapterEvaluationJob, type TrainingJob } from "../src/schemas.js";
import { runAdapterEvaluation, runMlxLoraTraining } from "../src/training-runner.js";

describe("training runner", () => {
  it("rejects adapter evaluation jobs without an explicit evaluation kind", () => {
    expect(() => AdapterEvaluationJobSchema.parse({
      job_id: "job_eval_missing_kind",
      run_id: "run_eval_missing_kind",
      round_id: "round_001",
      job_type: "evaluate_adapter",
      backend: "mlx",
      model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      adapter: {
        adapter_id: "job_adapter_missing_kind",
        artifact_uri: "file://artifacts/job_adapter_missing_kind/adapters",
        artifact_hash: "sha256:adapter-missing-kind",
      },
      eval_shard: {
        id: "eval_missing_kind",
        uri: "file://datasets/eval.jsonl",
        token_estimate: 1,
        hash: "sha256:eval-missing-kind",
      },
      max_examples: 2,
      max_tokens: 32,
    })).toThrow();
  });

  it("normalizes instruction-term adapter evaluations into leaderboard metrics", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-instruction-eval-test-"));
    try {
      const projectRoot = join(tempDir, "project");
      const datasetRoot = join(tempDir, "dataset");
      const adapterDir = join(tempDir, "adapter");
      const outputRoot = join(tempDir, "outputs");
      const cacheRoot = join(tempDir, "cache");
      const evalPath = join(datasetRoot, "instruction-eval.jsonl");
      const fakeScriptPath = join(projectRoot, "training", "mlx_lora_eval.py");

      await mkdir(datasetRoot, { recursive: true });
      await mkdir(adapterDir, { recursive: true });
      await mkdir(join(projectRoot, "training"), { recursive: true });
      await writeFile(evalPath, "{\"id\":\"case-1\"}\n", "utf8");
      await writeFile(fakeScriptPath, fakeInstructionEvalScript(), "utf8");

      const job: AdapterEvaluationJob = {
        job_id: "job_instruction_eval",
        run_id: "run_instruction_eval",
        round_id: "round_001",
        job_type: "evaluate_adapter",
        backend: "mlx",
        eval_kind: "instruction_terms",
        model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
        adapter: {
          adapter_id: "job_instruction_adapter",
          artifact_uri: pathToFileURL(adapterDir).toString(),
          artifact_hash: "sha256:instruction-adapter",
        },
        eval_shard: {
          id: "instruction_eval",
          uri: pathToFileURL(evalPath).toString(),
          token_estimate: 1,
          hash: await hashDatasetPath(evalPath),
        },
        max_examples: 2,
        max_tokens: 64,
      };

      const result = await runAdapterEvaluation(job, {
        projectRoot,
        outputRoot,
        datasetCacheRoot: cacheRoot,
        pythonBin: process.execPath,
      });

      expect(result.metrics.eval_kind).toBe("instruction_terms");
      expect(result.metrics.labels).toEqual(["pass", "fail"]);
      expect(result.metrics.examples).toBe(2);
      expect(result.metrics.correct).toBe(1);
      expect(result.metrics.accuracy).toBe(0.5);
      expect(result.metrics.invalid_rate).toBe(0);
      expect(result.metrics.results.map((item) => item.predicted_label)).toEqual(["pass", "fail"]);
      expect(result.manifest.artifact_type).toBe("adapter_evaluation");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

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
      const progressUpdates: Array<{ progress_percent: number; progress_label: string }> = [];

      const result = await runMlxLoraTraining(job, {
        projectRoot,
        outputRoot,
        datasetCacheRoot: cacheRoot,
        pythonBin: process.execPath,
        onProgress: (progress) => {
          progressUpdates.push({
            progress_percent: progress.progress_percent,
            progress_label: progress.progress_label,
          });
        },
      });

      const datasetInfo = await stat(result.metrics.dataset);
      expect(datasetInfo.isDirectory()).toBe(true);
      expect(result.metrics.dataset).toBe(join(cacheRoot, job.dataset_shard.hash.replace("sha256:", "")));
      expect(result.metrics.train_examples).toBe(1);
      expect(result.manifest.artifact_type).toBe("lora_adapter");
      expect(progressUpdates).toEqual([
        {
          progress_percent: 50,
          progress_label: "training 1/2 iters",
        },
        {
          progress_percent: 100,
          progress_label: "training 2/2 iters",
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function fakeInstructionEvalScript(): string {
  return `
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const args = parseArgs(process.argv.slice(2));
const outputDir = args["output-dir"];
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "eval.json"), JSON.stringify({
  model: args.model,
  adapter_path: args["adapter-path"],
  eval_file: args["eval-file"],
  examples: 2,
  passed: 1,
  pass_rate: 0.5,
  results: [
    { id: "case-1", output: "contains the required term", passed: true },
    { id: "case-2", output: "misses it", passed: false }
  ]
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
console.log("MARSHALL_PROGRESS " + JSON.stringify({
  progress_percent: 50,
  progress_label: "training 1/2 iters",
  work_units_done: 1,
  work_units_total: 2,
  throughput_units_per_second: 0.5,
  throughput_label: "iters/s",
}));
writeFileSync(join(adapterDir, "adapter_config.json"), "{}\\n", "utf8");
console.log("MARSHALL_PROGRESS " + JSON.stringify({
  progress_percent: 100,
  progress_label: "training 2/2 iters",
  work_units_done: 2,
  work_units_total: 2,
  throughput_units_per_second: 1,
  throughput_label: "iters/s",
}));
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
