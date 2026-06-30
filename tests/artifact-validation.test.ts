import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runArtifactValidation } from "../src/training-runner.js";
import type { AdapterEvaluationMetrics, ArtifactValidationJob } from "../src/schemas.js";

describe("artifact validation runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-artifact-validation-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("accepts adapter evaluation metrics that pass hash and quality policy", async () => {
    const metricsPath = await writeAdapterEvaluationMetrics(tempDir, {
      examples: 10,
      correct: 8,
      accuracy: 0.8,
      invalid: 0,
      invalid_rate: 0,
    });
    const job = validationJob(metricsPath, await sha256File(metricsPath), {
      min_accuracy: 0.5,
      max_invalid_rate: 0.1,
      min_examples: 5,
    });

    const result = await runArtifactValidation(job, {
      outputRoot: join(tempDir, "artifacts"),
    });

    expect(result.metrics.verdict).toBe("accepted");
    expect(result.metrics.reason).toBe("artifact passed validation policy");
    expect(result.metrics.observed).toEqual({
      accuracy: 0.8,
      invalid_rate: 0,
      examples: 10,
    });
    expect(result.manifest.artifact_type).toBe("artifact_validation");
    expect(result.manifest.validation).toMatchObject({
      target_job_id: "job_eval_test",
      target_worker_id: "worker_eval_test",
      verdict: "accepted",
    });

    const persisted = JSON.parse(await readFile(join(result.outputDir, "validation.json"), "utf8"));
    expect(persisted.verdict).toBe("accepted");
  });

  it("marks a target as malicious when the artifact hash does not match", async () => {
    const metricsPath = await writeAdapterEvaluationMetrics(tempDir, {
      examples: 10,
      correct: 8,
      accuracy: 0.8,
      invalid: 0,
      invalid_rate: 0,
    });
    const job = validationJob(metricsPath, "sha256:not-the-real-hash");

    const result = await runArtifactValidation(job, {
      outputRoot: join(tempDir, "artifacts"),
    });

    expect(result.metrics.verdict).toBe("malicious");
    expect(result.metrics.reason).toBe("artifact hash does not match the coordinator target");
    expect(result.metrics.checks).toContainEqual(expect.objectContaining({
      name: "artifact_hash",
      passed: false,
    }));
    expect(result.manifest.validation).toMatchObject({
      target_job_id: "job_eval_test",
      target_worker_id: "worker_eval_test",
      verdict: "malicious",
    });
  });
});

async function writeAdapterEvaluationMetrics(
  root: string,
  overrides: Pick<AdapterEvaluationMetrics, "examples" | "correct" | "accuracy" | "invalid" | "invalid_rate">,
): Promise<string> {
  const path = join(root, "adapter-evaluation-metrics.json");
  const metrics: AdapterEvaluationMetrics = {
    job_id: "job_eval_test",
    run_id: "run_validation_test",
    round_id: "round_001",
    adapter_id: "job_adapter_test",
    adapter_artifact_hash: "sha256:adapter-test",
    eval_shard_id: "eval_test",
    eval_shard_hash: "sha256:eval-test",
    model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    adapter_path: null,
    eval_file: "eval.jsonl",
    labels: ["World", "Sports"],
    results: [
      {
        id: "example-001",
        expected_label: "World",
        predicted_label: "World",
        correct: true,
        output: "World",
      },
    ],
    ...overrides,
  };
  await writeFile(path, JSON.stringify(metrics, null, 2) + "\n", "utf8");
  return path;
}

function validationJob(
  metricsPath: string,
  artifactHash: string,
  policy: ArtifactValidationJob["policy"] = {},
): ArtifactValidationJob {
  return {
    job_id: "job_validate_test",
    run_id: "run_validation_test",
    round_id: "round_001",
    job_type: "validate_artifact",
    backend: "cpu",
    target: {
      job_id: "job_eval_test",
      worker_id: "worker_eval_test",
      peer_id: "12D3KooWValidatorTarget",
      artifact_type: "adapter_evaluation",
      artifact_uri: pathToFileURL(metricsPath).toString(),
      artifact_hash: artifactHash,
      config_hash: "sha256:eval-config-test",
      metrics_uri: pathToFileURL(metricsPath).toString(),
    },
    policy,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}
