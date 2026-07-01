import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AdapterEvaluationMetrics } from "../src/schemas.js";

const execFileAsync = promisify(execFile);

describe("round orchestrator CLI", () => {
  it("creates evaluation jobs from LoRA artifacts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-round-eval-"));
    const artifactsFile = join(tempDir, "artifacts.json");
    const jobsDir = join(tempDir, "jobs");
    const evalFile = join(tempDir, "eval.jsonl");
    await writeFile(evalFile, "{\"id\":\"case-1\"}\n", "utf8");
    await writeFile(artifactsFile, JSON.stringify([
      artifact("job_train_001", "worker_train_001", "lora_adapter", "sha256:adapter-001"),
    ]), "utf8");

    const { stdout } = await execFileAsync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "src/round-orchestrator-cli.ts",
        "--phase",
        "evaluation",
        "--artifacts-file",
        artifactsFile,
        "--jobs-dir",
        jobsDir,
        "--run-id",
        "run_round_test",
        "--round-id",
        "round_001",
        "--eval-file",
        evalFile,
        "--eval-kind",
        "instruction_terms",
        "--model",
        "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
        "--max-examples",
        "3",
        "--max-tokens",
        "80",
        "--eval-min-memory-gb",
        "32",
      ],
      { cwd: process.cwd(), timeout: 10_000 },
    );

    const summary = JSON.parse(stdout);
    expect(summary.action).toBe("schedule_evaluation_jobs");
    expect(summary.jobs).toBe(1);

    const jobs = JSON.parse(await readFile(join(jobsDir, "evaluate-adapters.json"), "utf8"));
    expect(jobs[0].job_type).toBe("evaluate_adapter");
    expect(jobs[0].adapter.artifact_uri).toBe("marshall-artifact://job_train_001");
    expect(jobs[0].eval_kind).toBe("instruction_terms");
    expect(jobs[0].resource_requirements.min_memory_gb).toBe(32);
  });

  it("auto-schedules validation jobs for unvalidated evaluation artifacts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-round-validation-"));
    const artifactsFile = join(tempDir, "artifacts.json");
    const jobsDir = join(tempDir, "jobs");
    await writeFile(artifactsFile, JSON.stringify([
      artifact("job_eval_001", "worker_eval_001", "adapter_evaluation", "sha256:eval-001"),
    ]), "utf8");

    const { stdout } = await execFileAsync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "src/round-orchestrator-cli.ts",
        "--phase",
        "auto",
        "--artifacts-file",
        artifactsFile,
        "--jobs-dir",
        jobsDir,
        "--run-id",
        "run_round_test",
        "--round-id",
        "round_001",
        "--quorum",
        "2",
        "--validators-per-artifact",
        "2",
      ],
      { cwd: process.cwd(), timeout: 10_000 },
    );

    const summary = JSON.parse(stdout);
    expect(summary.action).toBe("schedule_validation_jobs");
    expect(summary.jobs).toBe(2);

    const jobs = JSON.parse(await readFile(join(jobsDir, "validate-artifacts.json"), "utf8"));
    expect(jobs).toHaveLength(2);
    expect(jobs[0].job_type).toBe("validate_artifact");
    expect(jobs[0].target.artifact_uri).toBe("marshall-artifact://job_eval_001");
    expect(jobs[0].policy.quorum).toBe(2);
  });

  it("selects accepted evaluations and writes a verified model package", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-round-selection-"));
    const artifactsFile = join(tempDir, "artifacts.json");
    const artifactStore = join(tempDir, "artifact-store");
    const leaderboardDir = join(tempDir, "leaderboard");
    const packageDir = join(tempDir, "package");
    const adapterPath = join(artifactStore, "adapter_001", "artifact");
    await mkdir(join(artifactStore, "job_train_001", "metrics"), { recursive: true });
    await mkdir(join(artifactStore, "job_eval_001", "artifact"), { recursive: true });
    await mkdir(adapterPath, { recursive: true });
    await writeFile(join(artifactStore, "job_train_001", "metrics", "metrics.json"), JSON.stringify({
      job_id: "job_train_001",
      final_train_loss: 1.2,
    }), "utf8");
    await writeFile(join(artifactStore, "job_eval_001", "artifact", "metrics.json"), JSON.stringify(
      metrics("job_eval_001", "adapter_001"),
    ), "utf8");
    await writeFile(join(artifactStore, "adapter_001", "manifest.json"), JSON.stringify({
      worker_id: "worker_train_001",
      peer_id: "peer_train_001",
      job_id: "adapter_001",
      artifact_type: "lora_adapter",
      artifact_uri: pathToFileURL(adapterPath).toString(),
      artifact_hash: "sha256:adapter_001",
      config_hash: "sha256:config-adapter-001",
      created_at: "2026-06-30T00:00:00.000Z",
    }), "utf8");
    await writeFile(artifactsFile, JSON.stringify([
      {
        ...artifact("job_eval_001", "worker_eval_001", "adapter_evaluation", "sha256:eval-001"),
        verdict: "accepted",
        verdict_status: "finalized",
        verdict_votes: 2,
        verdict_quorum: 2,
      },
    ]), "utf8");

    const { stdout } = await execFileAsync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "src/round-orchestrator-cli.ts",
        "--phase",
        "selection",
        "--artifacts-file",
        artifactsFile,
        "--artifact-store-dir",
        artifactStore,
        "--leaderboard-dir",
        leaderboardDir,
        "--package-dir",
        packageDir,
      ],
      { cwd: process.cwd(), timeout: 10_000 },
    );

    const summary = JSON.parse(stdout);
    expect(summary.action).toBe("select_model");
    expect(summary.evaluated_adapters).toBe(1);
    expect(summary.skipped_metrics).toBe(1);
    expect(summary.selected.adapter_id).toBe("adapter_001");
    expect(summary.package.package_job_id).toBe("optimized_model_adapter_001");

    const modelPackage = JSON.parse(await readFile(join(packageDir, "model_package.json"), "utf8"));
    expect(modelPackage.adapter_path).toBe(adapterPath);
    expect(modelPackage.adapter_uri).toBe("marshall-artifact://adapter_001");
    expect(modelPackage.eval.accuracy).toBe(2 / 3);

    const packageManifest = JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8"));
    expect(packageManifest.job_id).toBe("optimized_model_adapter_001");
    expect(packageManifest.artifact_type).toBe("optimized_model_package");

    const storedPackageManifest = JSON.parse(await readFile(join(artifactStore, "optimized_model_adapter_001", "manifest.json"), "utf8"));
    expect(storedPackageManifest).toMatchObject({
      worker_id: "marshall-control",
      peer_id: "marshall-control",
      job_id: "optimized_model_adapter_001",
      artifact_type: "optimized_model_package",
      artifact_hash: packageManifest.artifact_hash,
    });

    const registry = JSON.parse(await readFile(join(tempDir, "index.json"), "utf8"));
    expect(registry.models[0]).toMatchObject({
      base_model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      adapter_id: "adapter_001",
      adapter_uri: "marshall-artifact://adapter_001",
      package_job_id: "optimized_model_adapter_001",
      package_uri: "marshall-artifact://optimized_model_adapter_001",
      transfer: {
        protocol: "/marshall/artifact/fetch/1.0.0",
        chunked: true,
        hash_verified: true,
        https_payload: false,
      },
    });
  });
});

function artifact(jobId: string, workerId: string, artifactType: string, artifactHash: string) {
  return {
    job_id: jobId,
    worker_id: workerId,
    peer_id: `${workerId}_peer`,
    artifact_type: artifactType,
    artifact_uri: `file:///tmp/${jobId}/artifact`,
    artifact_hash: artifactHash,
    config_hash: `sha256:config-${jobId}`,
    metrics_uri: `file:///tmp/${jobId}/metrics.json`,
    created_at: "2026-06-30T00:00:00.000Z",
  };
}

function metrics(jobId: string, adapterId: string): AdapterEvaluationMetrics {
  return {
    job_id: jobId,
    run_id: "run_round_selection_test",
    round_id: "round_001",
    adapter_id: adapterId,
    adapter_artifact_hash: `sha256:${adapterId}`,
    eval_shard_id: "instruction_terms_jsonl",
    eval_shard_hash: "sha256:eval-shard",
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
