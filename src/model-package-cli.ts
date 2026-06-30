import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AdapterEvaluationMetricsSchema, TextClassifierEvaluationMetricsSchema, TrainingArtifactManifestSchema } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const optimizedModelPath = args["optimized-model"] ?? process.env.MARSHALL_OPTIMIZED_MODEL ?? ".marshall/leaderboard/optimized_model.json";
const outputDir = args["output-dir"] ?? process.env.MARSHALL_MODEL_PACKAGE_DIR ?? ".marshall/model-package";

const optimized = parseOptimizedModel(JSON.parse(await readFile(optimizedModelPath, "utf8")));
if (optimized.selected == null) {
  throw new Error(`${optimizedModelPath} does not contain a selected adapter`);
}

const metrics = parseEvaluationMetrics(JSON.parse(await readFile(optimized.selected.metrics_path, "utf8")));
const packagePath = join(outputDir, "model_package.json");
const manifestPath = join(outputDir, "manifest.json");
const createdAt = new Date().toISOString();

await mkdir(outputDir, { recursive: true });

const modelPackage = {
  type: "marshall_optimized_model_package",
  strategy: optimized.strategy,
  created_at: createdAt,
  model_kind: metrics.model_kind,
  base_model: metrics.model,
  adapter_id: optimized.selected.adapter_id,
  adapter_path: optimized.selected.adapter_path,
  adapter_artifact_hash: optimized.selected.adapter_artifact_hash,
  model_id: optimized.selected.model_id ?? optimized.selected.adapter_id,
  model_path: optimized.selected.model_path ?? optimized.selected.adapter_path,
  model_artifact_hash: optimized.selected.model_artifact_hash ?? optimized.selected.adapter_artifact_hash,
  eval: {
    job_id: optimized.selected.job_id,
    eval_shard_id: optimized.selected.eval_shard_id,
    examples: optimized.selected.examples,
    correct: optimized.selected.correct,
    accuracy: optimized.selected.accuracy,
    invalid: optimized.selected.invalid,
    invalid_rate: optimized.selected.invalid_rate,
    score: optimized.selected.score,
    metrics_path: optimized.selected.metrics_path,
  },
};
await writeFile(packagePath, JSON.stringify(modelPackage, null, 2) + "\n", "utf8");

const manifest = TrainingArtifactManifestSchema.parse({
  job_id: `optimized_model_${optimized.selected.adapter_id}`,
  artifact_type: "optimized_model_package",
  artifact_uri: pathToFileURL(resolve(packagePath)).toString(),
  artifact_hash: await sha256File(packagePath),
  config_hash: sha256Text(JSON.stringify({
    strategy: optimized.strategy,
    adapter_id: optimized.selected.adapter_id,
    adapter_artifact_hash: optimized.selected.adapter_artifact_hash,
    metrics_path: optimized.selected.metrics_path,
  })),
  created_at: createdAt,
  metrics_uri: pathToFileURL(resolve(optimized.selected.metrics_path)).toString(),
});
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  type: "marshall_model_package_created",
  optimized_model: optimizedModelPath,
  output_dir: outputDir,
  package_path: packagePath,
  manifest_path: manifestPath,
  adapter_id: optimized.selected.adapter_id,
  accuracy: optimized.selected.accuracy,
}, null, 2));

interface OptimizedModel {
  type: string;
  strategy: string;
  selected: LeaderboardEntry | null;
}

interface LeaderboardEntry {
  model_kind?: string;
  adapter_id: string;
  adapter_path: string;
  adapter_artifact_hash: string;
  model_id?: string;
  model_path?: string;
  model_artifact_hash?: string;
  job_id: string;
  eval_shard_id: string;
  examples: number;
  correct: number;
  accuracy: number;
  invalid: number;
  invalid_rate: number;
  score: number;
  metrics_path: string;
}

function parseOptimizedModel(value: unknown): OptimizedModel {
  if (typeof value !== "object" || value == null) {
    throw new Error("optimized model must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    type: stringValue(record.type, "type"),
    strategy: stringValue(record.strategy, "strategy"),
    selected: record.selected == null ? null : parseLeaderboardEntry(record.selected),
  };
}

function parseLeaderboardEntry(value: unknown): LeaderboardEntry {
  if (typeof value !== "object" || value == null) {
    throw new Error("selected adapter must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    adapter_id: stringValue(record.adapter_id, "selected.adapter_id"),
    adapter_path: stringValue(record.adapter_path, "selected.adapter_path"),
    adapter_artifact_hash: stringValue(record.adapter_artifact_hash, "selected.adapter_artifact_hash"),
    model_kind: optionalStringValue(record.model_kind, "selected.model_kind"),
    model_id: optionalStringValue(record.model_id, "selected.model_id"),
    model_path: optionalStringValue(record.model_path, "selected.model_path"),
    model_artifact_hash: optionalStringValue(record.model_artifact_hash, "selected.model_artifact_hash"),
    job_id: stringValue(record.job_id, "selected.job_id"),
    eval_shard_id: stringValue(record.eval_shard_id, "selected.eval_shard_id"),
    examples: numberValue(record.examples, "selected.examples"),
    correct: numberValue(record.correct, "selected.correct"),
    accuracy: numberValue(record.accuracy, "selected.accuracy"),
    invalid: numberValue(record.invalid, "selected.invalid"),
    invalid_rate: numberValue(record.invalid_rate, "selected.invalid_rate"),
    score: numberValue(record.score, "selected.score"),
    metrics_path: stringValue(record.metrics_path, "selected.metrics_path"),
  };
}

function parseEvaluationMetrics(value: unknown) {
  const adapter = AdapterEvaluationMetricsSchema.safeParse(value);
  if (adapter.success) {
    return {
      model_kind: "adapter",
      model: adapter.data.model,
    };
  }
  const classifier = TextClassifierEvaluationMetricsSchema.parse(value);
  return {
    model_kind: "text_classifier",
    model: classifier.model,
  };
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function optionalStringValue(value: unknown, field: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  return stringValue(value, field);
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
