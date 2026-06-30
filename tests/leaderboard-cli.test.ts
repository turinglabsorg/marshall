import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AdapterEvaluationMetrics } from "../src/schemas.js";

const execFileAsync = promisify(execFile);

describe("leaderboard CLI", () => {
  it("skips non-evaluation metrics in a mixed artifact store", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-leaderboard-cli-"));
    const artifactsDir = join(tempDir, "artifacts");
    const outputDir = join(tempDir, "leaderboard");
    await mkdir(join(artifactsDir, "job_train_001", "metrics"), { recursive: true });
    await mkdir(join(artifactsDir, "job_eval_001", "metrics"), { recursive: true });
    await writeFile(join(artifactsDir, "job_train_001", "metrics", "metrics.json"), JSON.stringify({
      job_id: "job_train_001",
      final_train_loss: 1.2,
    }), "utf8");
    await writeFile(
      join(artifactsDir, "job_eval_001", "metrics", "metrics.json"),
      JSON.stringify(metrics("job_eval_001", "adapter_001")),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "src/leaderboard-cli.ts",
        "--eval-artifacts-dir",
        artifactsDir,
        "--output-dir",
        outputDir,
      ],
      {
        cwd: process.cwd(),
        timeout: 10_000,
      },
    );

    const summary = JSON.parse(stdout);
    expect(summary.evaluated_adapters).toBe(1);
    expect(summary.skipped_metrics).toBe(1);

    const leaderboard = JSON.parse(await readFile(join(outputDir, "leaderboard.json"), "utf8"));
    expect(leaderboard.entries).toHaveLength(1);
    expect(leaderboard.entries[0].adapter_id).toBe("adapter_001");
  });
});

function metrics(jobId: string, adapterId: string): AdapterEvaluationMetrics {
  return {
    job_id: jobId,
    run_id: "run_leaderboard_cli_test",
    round_id: "round_001",
    adapter_id: adapterId,
    adapter_artifact_hash: `sha256:${adapterId}`,
    eval_shard_id: "eval_cli",
    eval_shard_hash: "sha256:eval-cli",
    eval_kind: "instruction_terms",
    model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    adapter_path: `/tmp/${adapterId}`,
    eval_file: "eval.jsonl",
    examples: 3,
    correct: 2,
    accuracy: 2 / 3,
    invalid: 0,
    invalid_rate: 0,
    labels: ["pass", "fail"],
    results: [],
  };
}
