import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TrainingJobSchema } from "../src/schemas.js";

const execFileAsync = promisify(execFile);

describe("dataset run CLI", () => {
  it("prepares a manifest-backed training run bundle from instruction records", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-dataset-run-cli-test-"));
    try {
      const inputPath = join(tempDir, "input.jsonl");
      const datasetDir = join(tempDir, "dataset");
      const runDir = join(tempDir, "run");
      await writeFile(inputPath, [
        JSON.stringify({ instruction: "Name the protocol.", context: "Marshall uses libp2p streams.", response: "Marshall uses libp2p." }),
        JSON.stringify({ instruction: "Name the validator output.", context: "", response: "Validators publish artifact_validation manifests." }),
        JSON.stringify({ instruction: "Where do local artifacts live?", context: "", response: "Local artifacts stay under .marshall." }),
        "",
      ].join("\n"), "utf8");

      const { stdout } = await execFileAsync(process.execPath, [
        join(process.cwd(), "node_modules/.bin/tsx"),
        "src/dataset-run-cli.ts",
        "--input-jsonl", inputPath,
        "--dataset-dir", datasetDir,
        "--dataset-id", "dataset-run-smoke",
        "--run-id", "run_dataset_smoke",
        "--round-id", "round_test",
        "--run-dir", runDir,
        "--shard-count", "3",
        "--job-count", "3",
        "--model", "mlx-community/Qwen2.5-1.5B-Instruct-4bit",
        "--iters", "12",
        "--learning-rate", "0.00002",
        "--num-layers", "6",
        "--instruction-field", "instruction",
        "--response-field", "response",
        "--context-field", "context",
      ], {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      });

      const summary = JSON.parse(stdout) as {
        type: string;
        job_count: number;
        published_jobs: number;
        jobs_file: string;
        manifest_path: string;
        run_file: string;
      };
      expect(summary.type).toBe("marshall_dataset_run_prepared");
      expect(summary.job_count).toBe(3);
      expect(summary.published_jobs).toBe(0);

      const manifest = JSON.parse(await readFile(summary.manifest_path, "utf8")) as { shards: unknown[] };
      expect(manifest.shards).toHaveLength(3);

      const jobs = JSON.parse(await readFile(summary.jobs_file, "utf8")) as unknown[];
      expect(jobs).toHaveLength(3);
      const parsedJob = TrainingJobSchema.parse(jobs[0]);
      expect(parsedJob).toMatchObject({
        run_id: "run_dataset_smoke",
        round_id: "round_test",
        job_type: "train_adapter",
        dataset_shard: {
          dataset_id: "dataset-run-smoke",
          files: expect.any(Array),
        },
        training_config: {
          model: "mlx-community/Qwen2.5-1.5B-Instruct-4bit",
          iters: 12,
          learning_rate: 0.00002,
          num_layers: 6,
        },
      });

      const run = JSON.parse(await readFile(summary.run_file, "utf8")) as {
        control: {
          jobs_file: string;
          adapter_dataset: string;
          adapter_dataset_dir: string;
        };
        training_config: {
          model: string;
          iters: number;
        };
      };
      expect(run.control).toMatchObject({
        jobs_file: summary.jobs_file,
        adapter_dataset: "manifest",
        adapter_dataset_dir: datasetDir,
      });
      expect(run.training_config).toMatchObject({
        model: "mlx-community/Qwen2.5-1.5B-Instruct-4bit",
        iters: 12,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
