import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("round daemon CLI", () => {
  it("does not rerun selection when the round state is already selected", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-round-daemon-cli-test-"));
    try {
      const jobsDir = join(tempDir, "jobs");
      const stateFile = join(jobsDir, "round-daemon-state.json");
      await mkdir(jobsDir, { recursive: true });
      await writeFile(stateFile, JSON.stringify({
        type: "marshall_round_daemon",
        action: "selected",
        run_id: "run_selected",
        round_id: "round_001",
        generated_at: "2026-07-02T00:00:00.000Z",
        result: {
          package: {
            package_job_id: "optimized_model_job_selected",
            package_artifact_hash: "sha256:selected",
          },
        },
      }, null, 2) + "\n", "utf8");

      const { stdout } = await execFileAsync(process.execPath, [
        join(process.cwd(), "node_modules/.bin/tsx"),
        "src/round-daemon-cli.ts",
        "--coordinator-url", "http://127.0.0.1:1",
        "--run-id", "run_selected",
        "--round-id", "round_001",
        "--jobs-dir", jobsDir,
        "--train-job-prefix", "job_train_selected",
        "--eval-job-prefix", "job_eval_selected",
        "--validation-job-prefix", "job_validate_selected",
        "--state-file", stateFile,
      ], {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      });

      const result = JSON.parse(stdout) as {
        action: string;
        run_id: string;
        round_id: string;
        result: {
          package: {
            package_artifact_hash: string;
          };
        };
      };
      expect(result).toMatchObject({
        type: "marshall_round_daemon",
        action: "already_selected",
        run_id: "run_selected",
        round_id: "round_001",
        result: {
          package: {
            package_artifact_hash: "sha256:selected",
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
