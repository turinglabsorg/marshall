import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactStoreManifestPath } from "./artifact-transfer.js";
import { AdapterEvaluationMetricsSchema, ArtifactManifestSchema, TrainingArtifactManifestSchema } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const optimizedModelPath = args["optimized-model"] ?? process.env.MARSHALL_OPTIMIZED_MODEL ?? ".marshall/leaderboard/optimized_model.json";
const outputDir = args["output-dir"] ?? process.env.MARSHALL_MODEL_PACKAGE_DIR ?? ".marshall/model-package";
const adapterArtifactsDir = args["adapter-artifacts-dir"] ?? process.env.MARSHALL_ADAPTER_ARTIFACTS_DIR;

const optimized = parseOptimizedModel(JSON.parse(await readFile(optimizedModelPath, "utf8")));
if (optimized.selected == null) {
  throw new Error(`${optimizedModelPath} does not contain a selected adapter`);
}

const metrics = AdapterEvaluationMetricsSchema.parse(JSON.parse(await readFile(optimized.selected.metrics_path, "utf8")));
const adapterPath = adapterArtifactsDir == null || adapterArtifactsDir === ""
  ? requiredString(optimized.selected.adapter_path, "selected.adapter_path")
  : await storedAdapterPath(adapterArtifactsDir, optimized.selected.adapter_id, optimized.selected.adapter_artifact_hash);
const packagePath = join(outputDir, "model_package.json");
const manifestPath = join(outputDir, "manifest.json");
const createdAt = new Date().toISOString();

await mkdir(outputDir, { recursive: true });

const modelPackage = {
  type: "marshall_optimized_model_package",
  strategy: optimized.strategy,
  selection_policy: optimized.selection_policy ?? null,
  created_at: createdAt,
  base_model: metrics.model,
  adapter_id: optimized.selected.adapter_id,
  adapter_path: adapterPath,
  adapter_artifact_hash: optimized.selected.adapter_artifact_hash,
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
    selection_policy: optimized.selection_policy ?? null,
    adapter_id: optimized.selected.adapter_id,
    adapter_artifact_hash: optimized.selected.adapter_artifact_hash,
    adapter_path: adapterPath,
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
  selection_policy?: unknown;
  selected: LeaderboardEntry | null;
}

interface LeaderboardEntry {
  adapter_id: string;
  adapter_path: string | null;
  adapter_artifact_hash: string;
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
    selection_policy: record.selection_policy,
    selected: record.selected == null ? null : parseLeaderboardEntry(record.selected),
  };
}

async function storedAdapterPath(artifactsDir: string, adapterId: string, adapterHash: string): Promise<string> {
  const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(artifactStoreManifestPath(artifactsDir, adapterId), "utf8")));
  if (manifest.artifact_hash !== adapterHash) {
    throw new Error(`stored adapter ${adapterId} hash mismatch: expected ${adapterHash}, got ${manifest.artifact_hash}`);
  }
  return manifest.artifact_uri.startsWith("file://") ? fileURLToPath(manifest.artifact_uri) : manifest.artifact_uri;
}

function parseLeaderboardEntry(value: unknown): LeaderboardEntry {
  if (typeof value !== "object" || value == null) {
    throw new Error("selected adapter must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    adapter_id: stringValue(record.adapter_id, "selected.adapter_id"),
    adapter_path: nullableStringValue(record.adapter_path, "selected.adapter_path"),
    adapter_artifact_hash: stringValue(record.adapter_artifact_hash, "selected.adapter_artifact_hash"),
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

function requiredString(value: string | null, field: string): string {
  if (value == null || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function nullableStringValue(value: unknown, field: string): string | null {
  if (value == null) {
    return null;
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
