import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDatasetShard } from "./dataset-cache.js";
import {
  AdapterEvaluationMetricsSchema,
  ArtifactValidationMetricsSchema,
  MlxLoraMetricsSchema,
  MlxSmokeMetricsSchema,
  ToyTrainingMetricsSchema,
  TrainingArtifactManifestSchema,
  type AdapterEvaluationJob,
  type AdapterEvaluationMetrics,
  type ArtifactValidationJob,
  type ArtifactValidationMetrics,
  type ArtifactValidationPolicy,
  type ArtifactValidationVerdict,
  type MlxLoraMetrics,
  type MlxSmokeMetrics,
  type ToyTrainingMetrics,
  type TrainingArtifactManifest,
  type TrainingJob,
  type WorkerHeartbeat,
} from "./schemas.js";

const PROGRESS_PREFIX = "MARSHALL_PROGRESS ";

export type TrainingProgressUpdate = Partial<Pick<
  WorkerHeartbeat,
  "work_units_done" | "work_units_total" | "throughput_units_per_second" | "throughput_label"
>> & {
  progress_percent: number;
  progress_label: string;
};

export interface ToyTrainingRunnerOptions {
  outputRoot: string;
  projectRoot?: string;
  pythonBin?: string;
  datasetCacheRoot?: string;
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

export interface MlxLoraRunnerOptions {
  outputRoot: string;
  projectRoot?: string;
  pythonBin?: string;
  datasetCacheRoot?: string;
  model?: string;
  iters?: number;
  batchSize?: number;
  learningRate?: number;
  numLayers?: number;
  maxSeqLength?: number;
  stepsPerReport?: number;
  stepsPerEval?: number;
  valBatches?: number;
  seed?: number;
  maskPrompt?: boolean;
  gradCheckpoint?: boolean;
  onProgress?: (progress: TrainingProgressUpdate) => void;
}

export interface MlxLoraRun {
  manifest: TrainingArtifactManifest;
  metrics: MlxLoraMetrics;
  outputDir: string;
  stdout: string;
  stderr: string;
}

export interface AdapterEvaluationRunnerOptions {
  outputRoot: string;
  projectRoot?: string;
  pythonBin?: string;
  datasetCacheRoot?: string;
}

export interface AdapterEvaluationRun {
  manifest: TrainingArtifactManifest;
  metrics: AdapterEvaluationMetrics;
  outputDir: string;
  stdout: string;
  stderr: string;
}

export interface ArtifactValidationRunnerOptions {
  outputRoot: string;
  projectRoot?: string;
}

export interface ArtifactValidationRun {
  manifest: TrainingArtifactManifest;
  metrics: ArtifactValidationMetrics;
  outputDir: string;
  stdout: string;
  stderr: string;
}

export async function runToyTraining(job: TrainingJob, options: ToyTrainingRunnerOptions): Promise<ToyTrainingRun> {
  if (job.job_type !== "train_toy_model") {
    throw new Error(`unsupported training job type: ${job.job_type}`);
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const preparedDataset = await prepareDatasetShard(job.dataset_shard, {
    projectRoot,
    cacheRoot: options.datasetCacheRoot,
  });
  const datasetPath = preparedDataset.path;
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

export async function runMlxLoraTraining(job: TrainingJob, options: MlxLoraRunnerOptions): Promise<MlxLoraRun> {
  if (job.job_type !== "train_adapter") {
    throw new Error(`unsupported MLX LoRA job type: ${job.job_type}`);
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const preparedDataset = await prepareDatasetShard(job.dataset_shard, {
    projectRoot,
    cacheRoot: options.datasetCacheRoot,
  });
  const datasetPath = preparedDataset.cachePath;
  const outputDir = resolve(options.outputRoot, job.job_id);
  const scriptPath = resolve(projectRoot, "training/mlx_lora_smoke.py");
  const adapterDir = join(outputDir, "adapters");
  const metricsPath = join(outputDir, "metrics.json");
  const model = options.model ?? "mlx-community/Qwen2.5-0.5B-Instruct-4bit";
  const iters = options.iters ?? 20;
  const batchSize = options.batchSize ?? 1;
  const learningRate = options.learningRate ?? 1e-5;
  const numLayers = options.numLayers ?? 4;
  const maxSeqLength = options.maxSeqLength ?? 512;
  const stepsPerReport = options.stepsPerReport ?? 10;
  const stepsPerEval = options.stepsPerEval ?? 20;
  const valBatches = options.valBatches ?? -1;
  const seed = options.seed ?? 42;
  const maskPrompt = options.maskPrompt ?? true;
  const gradCheckpoint = options.gradCheckpoint ?? false;

  await mkdir(outputDir, { recursive: true });

  const args = [
    scriptPath,
    "--dataset-dir",
    datasetPath,
    "--output-dir",
    outputDir,
    "--job-id",
    job.job_id,
    "--run-id",
    job.run_id,
    "--round-id",
    job.round_id,
    "--model",
    model,
    "--iters",
    String(iters),
    "--batch-size",
    String(batchSize),
    "--learning-rate",
    String(learningRate),
    "--num-layers",
    String(numLayers),
    "--max-seq-length",
    String(maxSeqLength),
    "--steps-per-report",
    String(stepsPerReport),
    "--steps-per-eval",
    String(stepsPerEval),
    "--val-batches",
    String(valBatches),
    "--seed",
    String(seed),
    maskPrompt ? "--mask-prompt" : "--no-mask-prompt",
  ];
  if (gradCheckpoint) {
    args.push("--grad-checkpoint");
  }

  const result = await runProcess(options.pythonBin ?? "python3", args, {
    onProgress: options.onProgress,
  });
  const metrics = MlxLoraMetricsSchema.parse(JSON.parse(await readFile(metricsPath, "utf8")));
  const configHash = sha256Text(JSON.stringify({
    job_type: job.job_type,
    backend: job.backend,
    script: "training/mlx_lora_smoke.py",
    dataset_hash: job.dataset_shard.hash,
    model,
    iters,
    batchSize,
    learningRate,
    numLayers,
    maxSeqLength,
    stepsPerReport,
    stepsPerEval,
    valBatches,
    seed,
    maskPrompt,
    gradCheckpoint,
  }));
  const manifest = TrainingArtifactManifestSchema.parse({
    job_id: job.job_id,
    artifact_type: "lora_adapter",
    artifact_uri: pathToFileURL(adapterDir).toString(),
    artifact_hash: await sha256Path(adapterDir),
    config_hash: configHash,
    created_at: new Date().toISOString(),
    metrics_uri: pathToFileURL(metricsPath).toString(),
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

export async function runAdapterEvaluation(
  job: AdapterEvaluationJob,
  options: AdapterEvaluationRunnerOptions,
): Promise<AdapterEvaluationRun> {
  const evalKind = job.eval_kind;
  const evalScript = adapterEvaluationScript(evalKind);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const preparedEval = await prepareDatasetShard(job.eval_shard, {
    projectRoot,
    cacheRoot: options.datasetCacheRoot,
  });
  const evalPath = preparedEval.path;
  const adapterPath = resolveArtifactUri(job.adapter.artifact_uri, projectRoot);
  const outputDir = resolve(options.outputRoot, job.job_id);
  const scriptPath = resolve(projectRoot, evalScript);
  const rawEvalPath = join(outputDir, "eval.json");
  const metricsPath = join(outputDir, "metrics.json");

  await mkdir(outputDir, { recursive: true });

  const args = [
    scriptPath,
    "--eval-file",
    evalPath,
    "--output-dir",
    outputDir,
    "--model",
    job.model,
    "--adapter-path",
    adapterPath,
    "--max-examples",
    String(job.max_examples),
    "--max-tokens",
    String(job.max_tokens),
  ];
  const result = await runProcess(options.pythonBin ?? "python3", args);
  const rawMetrics = JSON.parse(await readFile(rawEvalPath, "utf8"));
  const normalizedMetrics = normalizeAdapterEvaluationMetrics(evalKind, rawMetrics);
  const metrics = AdapterEvaluationMetricsSchema.parse({
    ...normalizedMetrics,
    job_id: job.job_id,
    run_id: job.run_id,
    round_id: job.round_id,
    adapter_id: job.adapter.adapter_id,
    adapter_artifact_hash: job.adapter.artifact_hash,
    eval_shard_id: job.eval_shard.id,
    eval_shard_hash: job.eval_shard.hash,
    eval_kind: evalKind,
  });
  await writeFile(metricsPath, JSON.stringify(metrics, null, 2) + "\n", "utf8");

  const configHash = sha256Text(JSON.stringify({
    job_type: job.job_type,
    backend: job.backend,
    eval_kind: evalKind,
    script: evalScript,
    model: job.model,
    adapter_id: job.adapter.adapter_id,
    adapter_hash: job.adapter.artifact_hash,
    eval_hash: job.eval_shard.hash,
    max_examples: job.max_examples,
    max_tokens: job.max_tokens,
  }));
  const manifest = TrainingArtifactManifestSchema.parse({
    job_id: job.job_id,
    artifact_type: "adapter_evaluation",
    artifact_uri: pathToFileURL(metricsPath).toString(),
    artifact_hash: await sha256File(metricsPath),
    config_hash: configHash,
    created_at: new Date().toISOString(),
    metrics_uri: pathToFileURL(metricsPath).toString(),
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

export async function runArtifactValidation(
  job: ArtifactValidationJob,
  options: ArtifactValidationRunnerOptions,
): Promise<ArtifactValidationRun> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputRoot, job.job_id);
  const validationPath = join(outputDir, "validation.json");
  const targetUri = job.target.metrics_uri ?? job.target.artifact_uri;
  const targetPath = resolveArtifactUri(targetUri, projectRoot);
  const policy = validationPolicy(job.policy);
  const checks: ArtifactValidationMetrics["checks"] = [];
  let observed: ArtifactValidationMetrics["observed"] | undefined;
  let verdict: ArtifactValidationVerdict = "accepted";
  let reason = "artifact passed validation policy";

  await mkdir(outputDir, { recursive: true });

  const actualHash = await sha256Path(targetPath);
  const hashPassed = actualHash === job.target.artifact_hash;
  checks.push({
    name: "artifact_hash",
    passed: hashPassed,
    detail: hashPassed ? actualHash : `expected ${job.target.artifact_hash}, got ${actualHash}`,
  });

  if (!hashPassed) {
    verdict = "malicious";
    reason = "artifact hash does not match the coordinator target";
  } else if (job.target.artifact_type !== "adapter_evaluation") {
    verdict = "rejected";
    reason = `unsupported validation target type: ${job.target.artifact_type}`;
    checks.push({
      name: "target_type",
      passed: false,
      detail: reason,
    });
  } else {
    try {
      const metrics = AdapterEvaluationMetricsSchema.parse(JSON.parse(await readFile(targetPath, "utf8")));
      observed = {
        accuracy: metrics.accuracy,
        invalid_rate: metrics.invalid_rate,
        examples: metrics.examples,
      };
      const examplesPassed = metrics.examples >= policy.min_examples;
      const invalidRatePassed = metrics.invalid_rate <= policy.max_invalid_rate;
      const accuracyPassed = metrics.accuracy >= policy.min_accuracy;
      checks.push(
        {
          name: "schema",
          passed: true,
          detail: "adapter evaluation metrics parsed",
        },
        ...adapterEvaluationConsistencyChecks(metrics),
        {
          name: "min_examples",
          passed: examplesPassed,
          detail: `${metrics.examples} >= ${policy.min_examples}`,
        },
        {
          name: "max_invalid_rate",
          passed: invalidRatePassed,
          detail: `${metrics.invalid_rate} <= ${policy.max_invalid_rate}`,
        },
        {
          name: "min_accuracy",
          passed: accuracyPassed,
          detail: `${metrics.accuracy} >= ${policy.min_accuracy}`,
        },
      );
      const consistencyPassed = checks
        .filter((check) => check.name.startsWith("metrics_"))
        .every((check) => check.passed);
      if (!consistencyPassed) {
        verdict = "malicious";
        reason = "adapter evaluation metrics are internally inconsistent";
      } else if (!examplesPassed || !invalidRatePassed) {
        verdict = "rejected";
        reason = "artifact evaluation metrics failed reliability policy";
      } else if (!accuracyPassed) {
        verdict = "poor";
        reason = "artifact evaluation accuracy is below policy threshold";
      }
    } catch (error) {
      verdict = "rejected";
      reason = error instanceof Error ? `metrics schema validation failed: ${error.message}` : "metrics schema validation failed";
      checks.push({
        name: "schema",
        passed: false,
        detail: reason,
      });
    }
  }

  const metrics = ArtifactValidationMetricsSchema.parse({
    job_id: job.job_id,
    run_id: job.run_id,
    round_id: job.round_id,
    target_job_id: job.target.job_id,
    target_worker_id: job.target.worker_id,
    target_artifact_type: job.target.artifact_type,
    target_artifact_hash: job.target.artifact_hash,
    verdict,
    reason,
    checks,
    observed,
    policy,
  });
  await writeFile(validationPath, JSON.stringify(metrics, null, 2) + "\n", "utf8");

  const configHash = sha256Text(JSON.stringify({
    job_type: job.job_type,
    backend: job.backend,
    target_job_id: job.target.job_id,
    target_worker_id: job.target.worker_id,
    target_artifact_hash: job.target.artifact_hash,
    policy,
  }));
  const manifest = TrainingArtifactManifestSchema.parse({
    job_id: job.job_id,
    artifact_type: "artifact_validation",
    artifact_uri: pathToFileURL(validationPath).toString(),
    artifact_hash: await sha256File(validationPath),
    config_hash: configHash,
    created_at: new Date().toISOString(),
    metrics_uri: pathToFileURL(validationPath).toString(),
    validation: {
      target_job_id: job.target.job_id,
      target_worker_id: job.target.worker_id,
      verdict,
      reason,
      quorum: policy.quorum,
    },
  });
  await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    manifest,
    metrics,
    outputDir,
    stdout: JSON.stringify(metrics),
    stderr: "",
  };
}

function validationPolicy(policy?: ArtifactValidationPolicy): Required<ArtifactValidationPolicy> {
  return {
    min_accuracy: policy?.min_accuracy ?? 0.3,
    max_invalid_rate: policy?.max_invalid_rate ?? 0.2,
    min_examples: policy?.min_examples ?? 1,
    quorum: policy?.quorum ?? 1,
  };
}

function adapterEvaluationConsistencyChecks(metrics: AdapterEvaluationMetrics): ArtifactValidationMetrics["checks"] {
  const expectedCorrect = metrics.results.filter((result) => result.correct).length;
  const expectedInvalid = metrics.results.filter((result) => result.predicted_label == null).length;
  const expectedAccuracy = expectedCorrect / metrics.examples;
  const expectedInvalidRate = expectedInvalid / metrics.examples;
  const labels = new Set(metrics.labels);
  const unknownLabels = metrics.results
    .map((result) => result.predicted_label)
    .filter((label): label is string => label != null && !labels.has(label));

  return [
    {
      name: "metrics_examples_match_results",
      passed: metrics.examples === metrics.results.length,
      detail: `${metrics.examples} examples, ${metrics.results.length} result rows`,
    },
    {
      name: "metrics_correct_count",
      passed: metrics.correct === expectedCorrect && metrics.correct <= metrics.examples,
      detail: `${metrics.correct} reported, ${expectedCorrect} computed`,
    },
    {
      name: "metrics_invalid_count",
      passed: metrics.invalid === expectedInvalid && metrics.invalid <= metrics.examples,
      detail: `${metrics.invalid} reported, ${expectedInvalid} computed`,
    },
    {
      name: "metrics_accuracy",
      passed: approximatelyEqual(metrics.accuracy, expectedAccuracy),
      detail: `${metrics.accuracy} reported, ${expectedAccuracy} computed`,
    },
    {
      name: "metrics_invalid_rate",
      passed: approximatelyEqual(metrics.invalid_rate, expectedInvalidRate),
      detail: `${metrics.invalid_rate} reported, ${expectedInvalidRate} computed`,
    },
    {
      name: "metrics_label_space",
      passed: unknownLabels.length === 0,
      detail: unknownLabels.length === 0 ? "all predicted labels are in label set" : `unknown labels: ${Array.from(new Set(unknownLabels)).join(", ")}`,
    },
  ];
}

function adapterEvaluationScript(evalKind: AdapterEvaluationJob["eval_kind"]): string {
  if (evalKind === "ag_news") {
    return "training/mlx_ag_news_eval.py";
  }
  if (evalKind === "instruction_terms") {
    return "training/mlx_lora_eval.py";
  }
  const exhaustive: never = evalKind;
  throw new Error(`unsupported adapter evaluation kind: ${exhaustive}`);
}

function normalizeAdapterEvaluationMetrics(
  evalKind: AdapterEvaluationJob["eval_kind"],
  rawMetrics: unknown,
): Record<string, unknown> {
  if (evalKind === "ag_news") {
    if (!isRecord(rawMetrics)) {
      throw new Error("AG News evaluation metrics must be a JSON object");
    }
    return rawMetrics;
  }
  if (evalKind === "instruction_terms") {
    return normalizeInstructionEvaluationMetrics(rawMetrics);
  }
  const exhaustive: never = evalKind;
  throw new Error(`unsupported adapter evaluation kind: ${exhaustive}`);
}

function normalizeInstructionEvaluationMetrics(rawMetrics: unknown): Record<string, unknown> {
  if (!isRecord(rawMetrics)) {
    throw new Error("instruction evaluation metrics must be a JSON object");
  }

  const rawResults = rawMetrics.results;
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    throw new Error("instruction evaluation metrics must include non-empty results");
  }

  const results = rawResults.map((result, index) => {
    if (!isRecord(result)) {
      throw new Error(`instruction evaluation result ${index + 1} must be a JSON object`);
    }
    const id = stringField(result, "id");
    const passed = booleanField(result, "passed");
    return {
      id,
      expected_label: "pass",
      predicted_label: passed ? "pass" : "fail",
      correct: passed,
      output: stringField(result, "output"),
    };
  });
  const correct = results.filter((result) => result.correct).length;
  const examples = results.length;

  return {
    model: stringField(rawMetrics, "model"),
    adapter_path: nullableStringField(rawMetrics, "adapter_path"),
    eval_file: stringField(rawMetrics, "eval_file"),
    examples,
    correct,
    accuracy: correct / examples,
    invalid: 0,
    invalid_rate: 0,
    labels: ["pass", "fail"],
    results,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected non-empty string field: ${key}`);
  }
  return value;
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected nullable string field: ${key}`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`expected boolean field: ${key}`);
  }
  return value;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function resolveArtifactUri(uri: string, projectRoot: string): string {
  if (uri.startsWith("file://")) {
    const path = fileURLToPath(uri);
    return path.startsWith("/") ? path : resolve(projectRoot, path);
  }
  return uri.startsWith("/") ? uri : resolve(projectRoot, uri);
}

async function runProcess(
  command: string,
  args: string[],
  options: { onProgress?: (progress: TrainingProgressUpdate) => void } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutPending = "";
    let stderrPending = "";
    let progressError: unknown;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutPending = consumeProgressLines(stdoutPending + chunk, options.onProgress, (error) => {
        progressError = error;
        child.kill();
      });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrPending = consumeProgressLines(stderrPending + chunk, options.onProgress, (error) => {
        progressError = error;
        child.kill();
      });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      consumeProgressLines(stdoutPending + "\n", options.onProgress, (error) => {
        progressError = error;
      });
      consumeProgressLines(stderrPending + "\n", options.onProgress, (error) => {
        progressError = error;
      });
      if (progressError != null) {
        reject(progressError);
        return;
      }
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }

      reject(new Error(`training process exited with code ${code ?? "unknown"}\n${stderr}`));
    });
  });
}

function consumeProgressLines(
  value: string,
  onProgress: ((progress: TrainingProgressUpdate) => void) | undefined,
  onError: (error: unknown) => void,
): string {
  const lines = value.split(/\r?\n/);
  const pending = lines.pop() ?? "";
  if (onProgress == null) {
    return pending;
  }
  for (const line of lines) {
    const progress = parseProgressLine(line);
    if (progress == null) {
      continue;
    }
    try {
      onProgress(progress);
    } catch (error) {
      onError(error);
    }
  }
  return pending;
}

function parseProgressLine(line: string): TrainingProgressUpdate | undefined {
  const prefixIndex = line.indexOf(PROGRESS_PREFIX);
  if (prefixIndex < 0) {
    return undefined;
  }
  const payload = line.slice(prefixIndex + PROGRESS_PREFIX.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const progressPercent = optionalNumberField(parsed, "progress_percent");
  const progressLabel = optionalStringField(parsed, "progress_label");
  if (progressPercent == null || progressLabel == null || progressLabel === "") {
    return undefined;
  }
  if (progressPercent < 0 || progressPercent > 100) {
    return undefined;
  }
  const progress: TrainingProgressUpdate = {
    progress_percent: progressPercent,
    progress_label: progressLabel,
  };
  const workUnitsDone = optionalNumberField(parsed, "work_units_done");
  if (workUnitsDone != null && workUnitsDone >= 0) {
    progress.work_units_done = workUnitsDone;
  }
  const workUnitsTotal = optionalNumberField(parsed, "work_units_total");
  if (workUnitsTotal != null && workUnitsTotal > 0) {
    progress.work_units_total = workUnitsTotal;
  }
  const throughputUnitsPerSecond = optionalNumberField(parsed, "throughput_units_per_second");
  if (throughputUnitsPerSecond != null && throughputUnitsPerSecond >= 0) {
    progress.throughput_units_per_second = throughputUnitsPerSecond;
  }
  const throughputLabel = optionalStringField(parsed, "throughput_label");
  if (throughputLabel != null && throughputLabel !== "") {
    progress.throughput_label = throughputLabel;
  }
  return progress;
}

function optionalNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}

async function sha256Path(path: string): Promise<string> {
  const info = await stat(path);
  if (info.isFile()) {
    return sha256File(path);
  }
  if (!info.isDirectory()) {
    throw new Error(`cannot hash non-file path: ${path}`);
  }

  const hash = createHash("sha256");
  await hashDirectory(hash, path, path);
  return `sha256:${hash.digest("hex")}`;
}

async function hashDirectory(hash: ReturnType<typeof createHash>, root: string, current: string): Promise<void> {
  const entries = (await readdir(current, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const path = join(current, entry.name);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      hash.update(`dir\0${rel}\0`);
      await hashDirectory(hash, root, path);
      continue;
    }
    if (entry.isFile()) {
      const content = await readFile(path);
      hash.update(`file\0${rel}\0${content.byteLength}\0`);
      hash.update(content);
    }
  }
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
