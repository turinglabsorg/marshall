import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MlxSmokeMetricsSchema,
  ToyTrainingMetricsSchema,
  TrainingArtifactManifestSchema,
  type MlxSmokeMetrics,
  type ToyTrainingMetrics,
  type TrainingArtifactManifest,
  type TrainingJob,
} from "./schemas.js";

export interface ToyTrainingRunnerOptions {
  outputRoot: string;
  projectRoot?: string;
  pythonBin?: string;
  epochs?: number;
  learningRate?: number;
}

export interface ToyTrainingRun {
  manifest: TrainingArtifactManifest;
  metrics: ToyTrainingMetrics;
  outputDir: string;
  stdout: string;
  stderr: string;
}

export interface MlxSmokeRunnerOptions {
  outputRoot: string;
  projectRoot?: string;
  pythonBin?: string;
}

export interface MlxSmokeRun {
  manifest: TrainingArtifactManifest;
  metrics: MlxSmokeMetrics;
  outputDir: string;
  stdout: string;
  stderr: string;
}

export async function runToyTraining(job: TrainingJob, options: ToyTrainingRunnerOptions): Promise<ToyTrainingRun> {
  if (job.job_type !== "train_toy_model") {
    throw new Error(`unsupported training job type: ${job.job_type}`);
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const datasetPath = resolveDatasetUri(job.dataset_shard.uri, projectRoot);
  const outputDir = resolve(options.outputRoot, job.job_id);
  const scriptPath = resolve(projectRoot, "training/tiny_char_lm.py");

  await mkdir(outputDir, { recursive: true });

  const result = await runProcess(options.pythonBin ?? "python3", [
    scriptPath,
    "--dataset",
    datasetPath,
    "--output-dir",
    outputDir,
    "--job-id",
    job.job_id,
    "--epochs",
    String(options.epochs ?? 25),
    "--learning-rate",
    String(options.learningRate ?? 0.35),
  ]);

  const manifest = TrainingArtifactManifestSchema.parse(
    JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")),
  );
  const metrics = ToyTrainingMetricsSchema.parse(
    JSON.parse(await readFile(join(outputDir, "metrics.json"), "utf8")),
  );

  return {
    manifest,
    metrics,
    outputDir,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function runMlxSmokeTraining(job: TrainingJob, options: MlxSmokeRunnerOptions): Promise<MlxSmokeRun> {
  if (job.job_type !== "train_mlx_smoke") {
    throw new Error(`unsupported MLX smoke job type: ${job.job_type}`);
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputRoot, job.job_id);
  const scriptPath = resolve(projectRoot, "training/mlx_linear_smoke.py");

  await mkdir(outputDir, { recursive: true });

  const result = await runProcess(options.pythonBin ?? "python3", [scriptPath]);
  const metrics = MlxSmokeMetricsSchema.parse(JSON.parse(result.stdout));
  const artifactPath = join(outputDir, "result.json");
  await writeFile(artifactPath, JSON.stringify({
    job_id: job.job_id,
    run_id: job.run_id,
    round_id: job.round_id,
    metrics,
  }, null, 2) + "\n", "utf8");

  const configHash = sha256Text(JSON.stringify({
    job_type: job.job_type,
    backend: job.backend,
    script: "training/mlx_linear_smoke.py",
    dataset_hash: job.dataset_shard.hash,
  }));
  const manifest = TrainingArtifactManifestSchema.parse({
    job_id: job.job_id,
    artifact_type: "mlx_smoke_result",
    artifact_uri: pathToFileURL(artifactPath).toString(),
    artifact_hash: await sha256File(artifactPath),
    config_hash: configHash,
    created_at: new Date().toISOString(),
  });
  await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    manifest,
    metrics,
    outputDir,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function resolveDatasetUri(uri: string, projectRoot: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`unsupported dataset URI: ${uri}`);
  }

  const path = uri.slice("file://".length);
  return path.startsWith("/") ? path : resolve(projectRoot, path);
}

async function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }

      reject(new Error(`training process exited with code ${code ?? "unknown"}\n${stderr}`));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
