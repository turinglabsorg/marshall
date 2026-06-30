import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactStoreManifestPath } from "./artifact-transfer.js";
import { CoordinatorClient, type CoordinatorArtifact } from "./coordinator-client.js";
import { hashDatasetPath } from "./dataset-cache.js";
import { rankAdapterEvaluations, type AdapterEvaluationCandidate } from "./model-selection.js";
import {
  AdapterEvaluationJobSchema,
  AdapterEvaluationMetricsSchema,
  ArtifactManifestSchema,
  ArtifactValidationJobSchema,
  TrainingArtifactManifestSchema,
  type AdapterEvaluationJob,
  type ArtifactValidationJob,
  type MarshallJob,
} from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const coordinatorUrl = args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL;
const coordinatorToken = args["coordinator-token"] ?? process.env.MARSHALL_COORDINATOR_TOKEN;
const artifactsFile = args["artifacts-file"] ?? process.env.MARSHALL_ARTIFACTS_FILE;

if ((coordinatorUrl == null || coordinatorUrl === "") && (artifactsFile == null || artifactsFile === "")) {
  throw new Error("--coordinator-url or --artifacts-file is required");
}

const coordinator = coordinatorUrl == null || coordinatorUrl === ""
  ? undefined
  : new CoordinatorClient(coordinatorUrl, { token: coordinatorToken });
const artifacts = artifactsFile == null || artifactsFile === ""
  ? await coordinator!.artifacts()
  : parseArtifacts(JSON.parse(await readFile(artifactsFile, "utf8")));
const publish = booleanArg(args.publish ?? process.env.MARSHALL_ROUND_PUBLISH, coordinator != null);
const runId = args["run-id"] ?? process.env.MARSHALL_RUN_ID ?? "run_round_orchestrated_001";
const roundId = args["round-id"] ?? process.env.MARSHALL_ROUND_ID ?? "round_001";
const jobsDir = resolve(args["jobs-dir"] ?? process.env.MARSHALL_JOBS_DIR ?? ".marshall/jobs");
const phase = args.phase ?? process.env.MARSHALL_ROUND_PHASE ?? "auto";

const action = await advanceRound({
  artifacts,
  phase,
  jobsDir,
  runId,
  roundId,
  publish,
  coordinator,
});

console.log(JSON.stringify(action, null, 2));

interface RoundAdvanceOptions {
  artifacts: CoordinatorArtifact[];
  phase: string;
  jobsDir: string;
  runId: string;
  roundId: string;
  publish: boolean;
  coordinator?: CoordinatorClient;
}

async function advanceRound(options: RoundAdvanceOptions) {
  const loraArtifacts = options.artifacts
    .filter((artifact) => artifact.artifact_type === "lora_adapter")
    .sort((left, right) => left.job_id.localeCompare(right.job_id));
  const evaluationArtifacts = options.artifacts
    .filter((artifact) => artifact.artifact_type === "adapter_evaluation")
    .sort((left, right) => left.job_id.localeCompare(right.job_id));
  const unvalidatedEvaluations = evaluationArtifacts.filter((artifact) => artifact.verdict == null || artifact.verdict === "");

  if (options.phase !== "auto" && !["evaluation", "validation", "selection"].includes(options.phase)) {
    throw new Error("--phase must be auto, evaluation, validation, or selection");
  }

  if ((options.phase === "auto" && unvalidatedEvaluations.length > 0) || options.phase === "validation") {
    return scheduleValidationJobs(unvalidatedEvaluations, options);
  }

  if ((options.phase === "auto" && evaluationArtifacts.length === 0 && loraArtifacts.length > 0) || options.phase === "evaluation") {
    return scheduleEvaluationJobs(loraArtifacts, options);
  }

  if ((options.phase === "auto" && evaluationArtifacts.length > 0 && unvalidatedEvaluations.length === 0) || options.phase === "selection") {
    return selectModel(evaluationArtifacts, options);
  }

  return {
    type: "marshall_round_advance",
    action: "wait",
    reason: "no eligible artifacts for the next round phase",
    artifacts: {
      lora_adapter: loraArtifacts.length,
      adapter_evaluation: evaluationArtifacts.length,
      unvalidated_adapter_evaluation: unvalidatedEvaluations.length,
    },
  };
}

async function scheduleEvaluationJobs(artifacts: CoordinatorArtifact[], options: RoundAdvanceOptions) {
  if (artifacts.length === 0) {
    return wait("no lora adapters available for evaluation", artifacts, []);
  }
  const evalFile = requiredArg("eval-file", args["eval-file"] ?? process.env.MARSHALL_EVAL_FILE);
  const evalPath = resolve(evalFile);
  const evalHash = await hashDatasetPath(evalPath);
  const evalKind = evalKindArg(requiredArg("eval-kind", args["eval-kind"] ?? process.env.MARSHALL_EVAL_KIND));
  const model = requiredArg("model", args.model ?? process.env.MARSHALL_MODEL);
  const maxExamples = positiveIntegerArg(requiredArg("max-examples", args["max-examples"] ?? process.env.MARSHALL_EVAL_EXAMPLES));
  const maxTokens = positiveIntegerArg(requiredArg("max-tokens", args["max-tokens"] ?? process.env.MARSHALL_EVAL_MAX_TOKENS));
  const jobPrefix = args["eval-job-prefix"] ?? process.env.MARSHALL_EVAL_JOB_PREFIX ?? "job_eval_adapter";
  const adapterJobPrefix = args["adapter-job-prefix"] ?? process.env.MARSHALL_EVAL_ADAPTER_JOB_PREFIX;
  const limit = optionalPositiveIntegerArg(args.limit ?? process.env.MARSHALL_ROUND_LIMIT);
  const selected = (adapterJobPrefix == null
    ? artifacts
    : artifacts.filter((artifact) => artifact.job_id.startsWith(adapterJobPrefix))
  ).slice(0, limit ?? artifacts.length);

  const jobs = selected.map((artifact, index) => {
    const suffix = String(index + 1).padStart(6, "0");
    return AdapterEvaluationJobSchema.parse({
      job_id: `${jobPrefix}_${suffix}`,
      run_id: args["eval-run-id"] ?? process.env.MARSHALL_EVAL_RUN_ID ?? `${options.runId}_eval`,
      round_id: options.roundId,
      job_type: "evaluate_adapter",
      backend: "mlx",
      eval_kind: evalKind,
      model,
      adapter: {
        adapter_id: artifact.job_id,
        artifact_uri: artifactUri("p2p", artifact.job_id, artifact.artifact_uri),
        artifact_hash: artifact.artifact_hash,
        config_hash: artifact.config_hash,
        source_job_id: artifact.job_id,
      },
      eval_shard: {
        id: basename(evalFile).replace(/[^a-zA-Z0-9_-]+/g, "_") || "eval_jsonl",
        uri: args["eval-uri"] ?? process.env.MARSHALL_EVAL_URI ?? pathToFileURL(evalPath).toString(),
        token_estimate: 1,
        hash: evalHash,
      },
      labels: evalKind === "ag_news" ? ["World", "Sports", "Business", "Sci/Tech"] : ["pass", "fail"],
      max_examples: maxExamples,
      max_tokens: maxTokens,
    });
  });
  return writeAndPublishJobs({
    action: "schedule_evaluation_jobs",
    jobType: "evaluate_adapter",
    outputFile: args["eval-jobs-file"] ?? process.env.MARSHALL_EVAL_JOBS_FILE ?? join(options.jobsDir, "evaluate-adapters.json"),
    jobs,
    options,
  });
}

async function scheduleValidationJobs(artifacts: CoordinatorArtifact[], options: RoundAdvanceOptions) {
  if (artifacts.length === 0) {
    return wait("no unvalidated adapter evaluations available", [], artifacts);
  }
  const quorum = positiveIntegerArg(args.quorum ?? process.env.MARSHALL_VALIDATION_QUORUM ?? "2");
  const validatorsPerArtifact = positiveIntegerArg(args["validators-per-artifact"] ?? process.env.MARSHALL_VALIDATORS_PER_ARTIFACT ?? String(quorum));
  if (validatorsPerArtifact < quorum) {
    throw new Error("--validators-per-artifact must be greater than or equal to --quorum");
  }
  const jobPrefix = args["validation-job-prefix"] ?? process.env.MARSHALL_VALIDATION_JOB_PREFIX ?? "job_validate_artifact";
  const limit = optionalPositiveIntegerArg(args.limit ?? process.env.MARSHALL_ROUND_LIMIT);
  const selected = artifacts.slice(0, limit ?? artifacts.length);
  const jobs = selected.flatMap((artifact, targetIndex) => (
    Array.from({ length: validatorsPerArtifact }, (_value, validatorIndex) => {
      const targetSuffix = String(targetIndex + 1).padStart(6, "0");
      const validatorSuffix = String(validatorIndex + 1).padStart(3, "0");
      return ArtifactValidationJobSchema.parse({
        job_id: `${jobPrefix}_${targetSuffix}_vote_${validatorSuffix}`,
        run_id: args["validation-run-id"] ?? process.env.MARSHALL_VALIDATION_RUN_ID ?? `${options.runId}_validation`,
        round_id: options.roundId,
        job_type: "validate_artifact",
        backend: "cpu",
        target: {
          job_id: artifact.job_id,
          worker_id: artifact.worker_id,
          peer_id: artifact.peer_id,
          artifact_type: artifact.artifact_type,
          artifact_uri: artifactUri("p2p", artifact.job_id, artifact.artifact_uri),
          artifact_hash: artifact.artifact_hash,
          config_hash: artifact.config_hash,
          metrics_uri: artifact.metrics_uri == null ? undefined : artifactUri("p2p", artifact.job_id, artifact.metrics_uri),
        },
        policy: {
          min_accuracy: numberArg(args["min-accuracy"] ?? process.env.MARSHALL_VALIDATION_MIN_ACCURACY ?? "0.3"),
          max_invalid_rate: numberArg(args["max-invalid-rate"] ?? process.env.MARSHALL_VALIDATION_MAX_INVALID_RATE ?? "0.2"),
          min_examples: positiveIntegerArg(args["min-examples"] ?? process.env.MARSHALL_VALIDATION_MIN_EXAMPLES ?? "1"),
          quorum,
        },
      });
    })
  ));
  return writeAndPublishJobs({
    action: "schedule_validation_jobs",
    jobType: "validate_artifact",
    outputFile: args["validation-jobs-file"] ?? process.env.MARSHALL_VALIDATION_JOBS_FILE ?? join(options.jobsDir, "validate-artifacts.json"),
    jobs,
    options,
  });
}

async function selectModel(artifacts: CoordinatorArtifact[], options: RoundAdvanceOptions) {
  const artifactStoreDir = requiredArg("artifact-store-dir", args["artifact-store-dir"] ?? process.env.MARSHALL_ARTIFACT_STORE_DIR);
  const outputDir = args["leaderboard-dir"] ?? process.env.MARSHALL_LEADERBOARD_DIR ?? join(dirname(options.jobsDir), "leaderboard");
  const topK = positiveIntegerArg(args["top-k"] ?? process.env.MARSHALL_TOP_K ?? "10");
  const requireVerdict = args["require-verdict"] ?? process.env.MARSHALL_LEADERBOARD_REQUIRE_VERDICT ?? "accepted";
  const artifactVerdicts = new Map(artifacts.map((artifact) => [artifact.job_id, artifact.verdict ?? ""]));
  const metricsPaths = await findMetrics(artifactStoreDir);
  const candidates: AdapterEvaluationCandidate[] = [];
  let skippedMetrics = 0;
  for (const path of metricsPaths) {
    const parsed = AdapterEvaluationMetricsSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) {
      skippedMetrics += 1;
      continue;
    }
    candidates.push({
      metrics: parsed.data,
      metricsPath: path,
      verdict: artifactVerdicts.get(parsed.data.job_id),
    });
  }

  const selection = rankAdapterEvaluations(candidates, {
    topK,
    requireVerdict,
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "leaderboard.json"), JSON.stringify({
    type: "marshall_adapter_leaderboard",
    selection_policy: selection.policy,
    entries: selection.entries,
  }, null, 2) + "\n", "utf8");
  await writeFile(join(outputDir, "top_k.json"), JSON.stringify({
    type: "marshall_adapter_top_k",
    selection_policy: selection.policy,
    top_k: selection.policy.top_k,
    entries: selection.topK,
  }, null, 2) + "\n", "utf8");
  const optimizedModel = {
    type: "marshall_optimized_model_selection",
    strategy: selection.policy.id,
    selection_policy: selection.policy,
    selected: selection.selected,
  };
  const optimizedModelPath = join(outputDir, "optimized_model.json");
  await writeFile(optimizedModelPath, JSON.stringify(optimizedModel, null, 2) + "\n", "utf8");

  const packageDir = args["package-dir"] ?? process.env.MARSHALL_MODEL_PACKAGE_DIR;
  let packageResult = null;
  if (packageDir != null && packageDir !== "" && selection.selected != null) {
    packageResult = await writeModelPackage({
      optimizedModel: {
        ...optimizedModel,
        selected: selection.selected,
      },
      optimizedModelPath,
      metricsPath: selection.selected.metrics_path,
      adapterArtifactsDir: args["adapter-artifacts-dir"] ?? process.env.MARSHALL_ADAPTER_ARTIFACTS_DIR ?? artifactStoreDir,
      outputDir: packageDir,
    });
  }

  return {
    type: "marshall_round_advance",
    action: "select_model",
    leaderboard_dir: outputDir,
    optimized_model: optimizedModelPath,
    evaluated_adapters: selection.entries.length,
    skipped_metrics: skippedMetrics,
    require_verdict: requireVerdict,
    selected: selection.selected,
    package: packageResult,
  };
}

async function writeAndPublishJobs(values: {
  action: "schedule_evaluation_jobs" | "schedule_validation_jobs";
  jobType: "evaluate_adapter" | "validate_artifact";
  outputFile: string;
  jobs: Array<AdapterEvaluationJob | ArtifactValidationJob>;
  options: RoundAdvanceOptions;
}) {
  await mkdir(dirname(values.outputFile), { recursive: true });
  await writeFile(values.outputFile, JSON.stringify(values.jobs, null, 2) + "\n", "utf8");
  let publishedJobs = 0;
  if (values.options.publish) {
    if (values.options.coordinator == null) {
      throw new Error("--publish requires --coordinator-url");
    }
    await values.options.coordinator.initializeJobs(values.jobs as MarshallJob[]);
    publishedJobs = values.jobs.length;
  }
  return {
    type: "marshall_round_advance",
    action: values.action,
    job_type: values.jobType,
    jobs_file: values.outputFile,
    jobs: values.jobs.length,
    published_jobs: publishedJobs,
    control: {
      job_type: values.jobType,
      jobs_file: values.outputFile,
    },
  };
}

async function writeModelPackage(values: {
  optimizedModel: {
    type: string;
    strategy: string;
    selection_policy: unknown;
    selected: NonNullable<ReturnType<typeof rankAdapterEvaluations>["selected"]>;
  };
  optimizedModelPath: string;
  metricsPath: string;
  adapterArtifactsDir: string;
  outputDir: string;
}) {
  const selected = values.optimizedModel.selected;
  const metrics = AdapterEvaluationMetricsSchema.parse(JSON.parse(await readFile(values.metricsPath, "utf8")));
  const adapterPath = await storedAdapterPath(values.adapterArtifactsDir, selected.adapter_id, selected.adapter_artifact_hash);
  const packagePath = join(values.outputDir, "model_package.json");
  const manifestPath = join(values.outputDir, "manifest.json");
  const createdAt = new Date().toISOString();
  await mkdir(values.outputDir, { recursive: true });

  await writeFile(packagePath, JSON.stringify({
    type: "marshall_optimized_model_package",
    strategy: values.optimizedModel.strategy,
    selection_policy: values.optimizedModel.selection_policy,
    created_at: createdAt,
    base_model: metrics.model,
    adapter_id: selected.adapter_id,
    adapter_path: adapterPath,
    adapter_artifact_hash: selected.adapter_artifact_hash,
    eval: {
      job_id: selected.job_id,
      eval_shard_id: selected.eval_shard_id,
      examples: selected.examples,
      correct: selected.correct,
      accuracy: selected.accuracy,
      invalid: selected.invalid,
      invalid_rate: selected.invalid_rate,
      score: selected.score,
      metrics_path: selected.metrics_path,
    },
  }, null, 2) + "\n", "utf8");

  const manifest = TrainingArtifactManifestSchema.parse({
    job_id: `optimized_model_${selected.adapter_id}`,
    artifact_type: "optimized_model_package",
    artifact_uri: pathToFileURL(resolve(packagePath)).toString(),
    artifact_hash: await sha256File(packagePath),
    config_hash: sha256Text(JSON.stringify({
      strategy: values.optimizedModel.strategy,
      selection_policy: values.optimizedModel.selection_policy,
      adapter_id: selected.adapter_id,
      adapter_artifact_hash: selected.adapter_artifact_hash,
      adapter_path: adapterPath,
      metrics_path: selected.metrics_path,
    })),
    created_at: createdAt,
    metrics_uri: pathToFileURL(resolve(selected.metrics_path)).toString(),
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    output_dir: values.outputDir,
    package_path: packagePath,
    manifest_path: manifestPath,
    adapter_id: selected.adapter_id,
  };
}

async function storedAdapterPath(artifactsDir: string, adapterId: string, adapterHash: string): Promise<string> {
  const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(artifactStoreManifestPath(artifactsDir, adapterId), "utf8")));
  if (manifest.artifact_hash !== adapterHash) {
    throw new Error(`stored adapter ${adapterId} hash mismatch: expected ${adapterHash}, got ${manifest.artifact_hash}`);
  }
  return manifest.artifact_uri.startsWith("file://") ? fileURLToPath(manifest.artifact_uri) : manifest.artifact_uri;
}

function wait(reason: string, loraArtifacts: unknown[], evaluationArtifacts: unknown[]) {
  return {
    type: "marshall_round_advance",
    action: "wait",
    reason,
    artifacts: {
      lora_adapter: loraArtifacts.length,
      adapter_evaluation: evaluationArtifacts.length,
    },
  };
}

function artifactUri(mode: "p2p", jobId: string, fallback: string): string {
  return mode === "p2p" ? `marshall-artifact://${jobId}` : fallback;
}

async function findMetrics(root: string): Promise<string[]> {
  const paths: string[] = [];
  await walk(root, paths);
  return paths.filter((path) => basename(path) === "metrics.json");
}

async function walk(path: string, output: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await walk(child, output);
      continue;
    }
    if (entry.isFile()) {
      output.push(child);
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseArtifacts(value: unknown): CoordinatorArtifact[] {
  if (!Array.isArray(value)) {
    throw new Error("--artifacts-file must contain a JSON array");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item == null) {
      throw new Error("artifact item must be an object");
    }
    const record = item as Record<string, unknown>;
    return {
      job_id: stringField(record, "job_id"),
      worker_id: stringField(record, "worker_id"),
      peer_id: stringField(record, "peer_id"),
      artifact_type: stringField(record, "artifact_type"),
      artifact_uri: stringField(record, "artifact_uri"),
      artifact_hash: stringField(record, "artifact_hash"),
      config_hash: stringField(record, "config_hash"),
      metrics_uri: optionalStringField(record, "metrics_uri"),
      created_at: optionalStringField(record, "created_at"),
      verdict: optionalStringField(record, "verdict"),
      verdict_at: optionalStringField(record, "verdict_at"),
      verdict_status: optionalStringField(record, "verdict_status"),
      verdict_votes: optionalNumberField(record, "verdict_votes"),
      verdict_quorum: optionalNumberField(record, "verdict_quorum"),
    };
  });
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid artifact.${field}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid artifact.${field}`);
  }
  return value;
}

function optionalNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`invalid artifact.${field}`);
  }
  return value;
}

function requiredArg(name: string, value: string | undefined): string {
  if (value == null || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function evalKindArg(value: string): "ag_news" | "instruction_terms" {
  if (value === "ag_news" || value === "instruction_terms") {
    return value;
  }
  throw new Error(`unsupported adapter evaluation kind: ${value}`);
}

function positiveIntegerArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function optionalPositiveIntegerArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return positiveIntegerArg(value);
}

function numberArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}

function booleanArg(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new Error(`invalid boolean: ${value}`);
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
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
