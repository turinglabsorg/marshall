import { readFile } from "node:fs/promises";
import {
  createOptimizedModelPackage,
  publishExistingModelPackage,
  type LeaderboardEntry,
  type OptimizedModelSelection,
} from "./model-package.js";

const args = parseArgs(process.argv.slice(2));
const existingPackagePath = args["package"] ?? args["model-package"] ?? process.env.MARSHALL_MODEL_PACKAGE;
const existingManifestPath = args["manifest"] ?? process.env.MARSHALL_MODEL_PACKAGE_MANIFEST;
const artifactStoreDir = args["artifact-store-dir"] ?? process.env.MARSHALL_ARTIFACT_STORE_DIR;
const registryPath = args["registry-path"] ?? process.env.MARSHALL_MODEL_REGISTRY_PATH;

if (existingPackagePath != null && existingPackagePath !== "") {
  if (existingManifestPath == null || existingManifestPath === "") {
    throw new Error("--manifest is required when publishing an existing package");
  }
  const result = await publishExistingModelPackage({
    packagePath: existingPackagePath,
    manifestPath: existingManifestPath,
    artifactStoreDir,
    registryPath,
    runId: args["run-id"] ?? process.env.MARSHALL_RUN_ID,
    publisherPeerId: args["publisher-peer-id"] ?? process.env.MARSHALL_MODEL_PUBLISHER_PEER_ID,
    publisherWorkerId: args["publisher-worker-id"] ?? process.env.MARSHALL_MODEL_PUBLISHER_WORKER_ID,
  });
  console.log(JSON.stringify({
    type: "marshall_model_package_published",
    package_path: existingPackagePath,
    manifest_path: existingManifestPath,
    artifact_store_manifest_path: result.artifactStoreManifestPath,
    registry_path: result.registryPath,
    package_job_id: result.entry.package_job_id,
    package_artifact_hash: result.entry.package_artifact_hash,
    adapter_id: result.entry.adapter_id,
  }, null, 2));
} else {
  const optimizedModelPath = args["optimized-model"] ?? process.env.MARSHALL_OPTIMIZED_MODEL ?? ".marshall/leaderboard/optimized_model.json";
  const outputDir = args["output-dir"] ?? process.env.MARSHALL_MODEL_PACKAGE_DIR ?? ".marshall/model-package";
  const adapterArtifactsDir = args["adapter-artifacts-dir"] ?? process.env.MARSHALL_ADAPTER_ARTIFACTS_DIR ?? artifactStoreDir;
  if (adapterArtifactsDir == null || adapterArtifactsDir === "") {
    throw new Error("--adapter-artifacts-dir or --artifact-store-dir is required");
  }
  const optimized = parseOptimizedModel(JSON.parse(await readFile(optimizedModelPath, "utf8")));
  if (optimized.selected == null) {
    throw new Error(`${optimizedModelPath} does not contain a selected adapter`);
  }
  const result = await createOptimizedModelPackage({
    optimizedModel: {
      strategy: optimized.strategy,
      selection_policy: optimized.selection_policy ?? null,
      selected: optimized.selected,
    },
    metricsPath: optimized.selected.metrics_path,
    adapterArtifactsDir,
    outputDir,
    artifactStoreDir,
    registryPath,
    publisherPeerId: args["publisher-peer-id"] ?? process.env.MARSHALL_MODEL_PUBLISHER_PEER_ID,
    publisherWorkerId: args["publisher-worker-id"] ?? process.env.MARSHALL_MODEL_PUBLISHER_WORKER_ID,
  });
  console.log(JSON.stringify({
    type: "marshall_model_package_created",
    optimized_model: optimizedModelPath,
    ...result,
  }, null, 2));
}

interface OptimizedModel {
  type: string;
  strategy: string;
  selection_policy?: unknown;
  selected: LeaderboardEntry | null;
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
