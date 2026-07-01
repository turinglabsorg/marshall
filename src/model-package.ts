import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactStoreManifestPath, sha256File } from "./artifact-transfer.js";
import { PROTOCOLS } from "./protocols.js";
import {
  AdapterEvaluationMetricsSchema,
  ArtifactManifestSchema,
  TrainingArtifactManifestSchema,
  type ArtifactManifest,
  type TrainingArtifactManifest,
} from "./schemas.js";

export interface LeaderboardEntry {
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

export interface OptimizedModelSelection {
  type?: string;
  strategy: string;
  selection_policy?: unknown;
  selected: LeaderboardEntry;
}

export interface ModelPackageEval {
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

export interface OptimizedModelPackage {
  type: "marshall_optimized_model_package";
  strategy: string;
  selection_policy: unknown;
  created_at: string;
  run_id: string;
  base_model: string;
  adapter_id: string;
  adapter_uri: string;
  adapter_path: string;
  adapter_artifact_hash: string;
  eval: ModelPackageEval;
}

export interface ModelRegistryEntry {
  status: "ready";
  run_id: string;
  created_at: string;
  base_model: string;
  adapter_id: string;
  adapter_uri: string;
  adapter_artifact_hash: string;
  package_job_id: string;
  package_uri: string;
  package_artifact_hash: string;
  eval: ModelPackageEval;
  transfer: {
    protocol: string;
    chunked: true;
    hash_verified: true;
    https_payload: false;
  };
}

export interface ModelRegistry {
  type: "marshall_model_registry";
  version: 1;
  updated_at: string;
  models: ModelRegistryEntry[];
}

export interface CreateOptimizedModelPackageOptions {
  optimizedModel: OptimizedModelSelection;
  metricsPath: string;
  adapterArtifactsDir: string;
  outputDir: string;
  artifactStoreDir?: string;
  registryPath?: string;
  publisherPeerId?: string;
  publisherWorkerId?: string;
}

export interface CreateOptimizedModelPackageResult {
  output_dir: string;
  package_path: string;
  manifest_path: string;
  artifact_store_manifest_path: string | null;
  registry_path: string | null;
  package_job_id: string;
  package_artifact_hash: string;
  adapter_id: string;
}

export async function createOptimizedModelPackage(
  values: CreateOptimizedModelPackageOptions,
): Promise<CreateOptimizedModelPackageResult> {
  const selected = values.optimizedModel.selected;
  const metrics = AdapterEvaluationMetricsSchema.parse(JSON.parse(await readFile(values.metricsPath, "utf8")));
  const adapterPath = await storedAdapterPath(values.adapterArtifactsDir, selected.adapter_id, selected.adapter_artifact_hash);
  const packagePath = join(values.outputDir, "model_package.json");
  const manifestPath = join(values.outputDir, "manifest.json");
  const createdAt = new Date().toISOString();
  const modelPackage: OptimizedModelPackage = {
    type: "marshall_optimized_model_package",
    strategy: values.optimizedModel.strategy,
    selection_policy: values.optimizedModel.selection_policy ?? null,
    created_at: createdAt,
    run_id: metrics.run_id,
    base_model: metrics.model,
    adapter_id: selected.adapter_id,
    adapter_uri: modelArtifactUri(selected.adapter_id),
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
  };

  await mkdir(values.outputDir, { recursive: true });
  await writeFile(packagePath, JSON.stringify(modelPackage, null, 2) + "\n", "utf8");

  const manifest = TrainingArtifactManifestSchema.parse({
    job_id: packageJobId(selected.adapter_id),
    artifact_type: "optimized_model_package",
    artifact_uri: pathToFileURL(resolve(packagePath)).toString(),
    artifact_hash: await sha256File(packagePath),
    config_hash: sha256Text(JSON.stringify({
      strategy: values.optimizedModel.strategy,
      selection_policy: values.optimizedModel.selection_policy ?? null,
      base_model: metrics.model,
      adapter_id: selected.adapter_id,
      adapter_uri: modelPackage.adapter_uri,
      adapter_artifact_hash: selected.adapter_artifact_hash,
      metrics_path: selected.metrics_path,
    })),
    created_at: createdAt,
    metrics_uri: pathToFileURL(resolve(selected.metrics_path)).toString(),
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const publish = await publishModelPackageArtifact({
    modelPackage,
    manifest,
    artifactStoreDir: values.artifactStoreDir,
    registryPath: values.registryPath ?? defaultRegistryPath(values.outputDir),
    publisherPeerId: values.publisherPeerId,
    publisherWorkerId: values.publisherWorkerId,
  });

  return {
    output_dir: values.outputDir,
    package_path: packagePath,
    manifest_path: manifestPath,
    artifact_store_manifest_path: publish.artifactStoreManifestPath,
    registry_path: publish.registryPath,
    package_job_id: manifest.job_id,
    package_artifact_hash: manifest.artifact_hash,
    adapter_id: selected.adapter_id,
  };
}

export async function publishExistingModelPackage(options: {
  packagePath: string;
  manifestPath: string;
  artifactStoreDir?: string;
  registryPath?: string;
  runId?: string;
  publisherPeerId?: string;
  publisherWorkerId?: string;
}): Promise<{
  artifactStoreManifestPath: string | null;
  registryPath: string | null;
  entry: ModelRegistryEntry;
}> {
  const parsedPackage = parseOptimizedModelPackage(JSON.parse(await readFile(options.packagePath, "utf8")));
  const modelPackage = {
    ...parsedPackage,
    run_id: options.runId ?? (parsedPackage.run_id === "unknown_run" ? basename(dirname(options.packagePath)) : parsedPackage.run_id),
  };
  const manifest = TrainingArtifactManifestSchema.parse(JSON.parse(await readFile(options.manifestPath, "utf8")));
  if (manifest.artifact_hash !== await sha256File(options.packagePath)) {
    throw new Error(`model package hash mismatch for ${options.packagePath}`);
  }
  return publishModelPackageArtifact({
    modelPackage,
    manifest,
    artifactStoreDir: options.artifactStoreDir,
    registryPath: options.registryPath ?? defaultRegistryPath(dirname(options.packagePath)),
    publisherPeerId: options.publisherPeerId,
    publisherWorkerId: options.publisherWorkerId,
  });
}

export async function publishModelPackageArtifact(options: {
  modelPackage: OptimizedModelPackage;
  manifest: TrainingArtifactManifest;
  artifactStoreDir?: string;
  registryPath?: string;
  publisherPeerId?: string;
  publisherWorkerId?: string;
}): Promise<{
  artifactStoreManifestPath: string | null;
  registryPath: string | null;
  entry: ModelRegistryEntry;
}> {
  const entry = registryEntry(options.modelPackage, options.manifest);
  let artifactStoreManifest: string | null = null;
  if (options.artifactStoreDir != null && options.artifactStoreDir !== "") {
    artifactStoreManifest = artifactStoreManifestPath(options.artifactStoreDir, options.manifest.job_id);
    await mkdir(dirname(artifactStoreManifest), { recursive: true });
    await writeFile(artifactStoreManifest, JSON.stringify(fullArtifactManifest(options.manifest, {
      peerId: options.publisherPeerId,
      workerId: options.publisherWorkerId,
    }), null, 2) + "\n", "utf8");
  }

  let registryPath: string | null = null;
  if (options.registryPath != null && options.registryPath !== "") {
    registryPath = options.registryPath;
    await upsertRegistry(registryPath, entry);
  }

  return {
    artifactStoreManifestPath: artifactStoreManifest,
    registryPath,
    entry,
  };
}

export function parseOptimizedModelPackage(value: unknown): OptimizedModelPackage {
  if (typeof value !== "object" || value == null) {
    throw new Error("model package must be an object");
  }
  const record = value as Record<string, unknown>;
  const selectedRunId = stringValue(record.run_id ?? nestedValue(record.eval, "run_id"), "run_id", true);
  return {
    type: literalString(record.type, "type", "marshall_optimized_model_package"),
    strategy: stringValue(record.strategy, "strategy"),
    selection_policy: record.selection_policy ?? null,
    created_at: stringValue(record.created_at, "created_at"),
    run_id: selectedRunId || "unknown_run",
    base_model: stringValue(record.base_model, "base_model"),
    adapter_id: stringValue(record.adapter_id, "adapter_id"),
    adapter_uri: stringValue(record.adapter_uri ?? modelArtifactUri(stringValue(record.adapter_id, "adapter_id")), "adapter_uri"),
    adapter_path: stringValue(record.adapter_path, "adapter_path"),
    adapter_artifact_hash: stringValue(record.adapter_artifact_hash, "adapter_artifact_hash"),
    eval: parseModelPackageEval(record.eval),
  };
}

export function modelArtifactUri(jobId: string): string {
  return `marshall-artifact://${jobId}`;
}

export function packageJobId(adapterId: string): string {
  return `optimized_model_${adapterId}`;
}

export function safeModelPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "model";
}

function registryEntry(modelPackage: OptimizedModelPackage, manifest: TrainingArtifactManifest): ModelRegistryEntry {
  return {
    status: "ready",
    run_id: modelPackage.run_id,
    created_at: modelPackage.created_at,
    base_model: modelPackage.base_model,
    adapter_id: modelPackage.adapter_id,
    adapter_uri: modelPackage.adapter_uri,
    adapter_artifact_hash: modelPackage.adapter_artifact_hash,
    package_job_id: manifest.job_id,
    package_uri: modelArtifactUri(manifest.job_id),
    package_artifact_hash: manifest.artifact_hash,
    eval: modelPackage.eval,
    transfer: {
      protocol: PROTOCOLS.artifactFetch,
      chunked: true,
      hash_verified: true,
      https_payload: false,
    },
  };
}

async function upsertRegistry(path: string, entry: ModelRegistryEntry): Promise<void> {
  const existing = await readRegistry(path);
  const models = [
    entry,
    ...existing.models.filter((item) => item.package_job_id !== entry.package_job_id),
  ].sort((left, right) => right.created_at.localeCompare(left.created_at));
  const registry: ModelRegistry = {
    type: "marshall_model_registry",
    version: 1,
    updated_at: new Date().toISOString(),
    models,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

async function readRegistry(path: string): Promise<ModelRegistry> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.type !== "marshall_model_registry" || parsed?.version !== 1 || !Array.isArray(parsed?.models)) {
      throw new Error(`${path} is not a Marshall model registry`);
    }
    return {
      type: "marshall_model_registry",
      version: 1,
      updated_at: stringValue(parsed.updated_at, "updated_at", true) || new Date(0).toISOString(),
      models: parsed.models.map(parseRegistryEntry),
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        type: "marshall_model_registry",
        version: 1,
        updated_at: new Date(0).toISOString(),
        models: [],
      };
    }
    throw error;
  }
}

function parseRegistryEntry(value: unknown): ModelRegistryEntry {
  if (typeof value !== "object" || value == null) {
    throw new Error("registry entry must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    status: "ready",
    run_id: stringValue(record.run_id, "run_id"),
    created_at: stringValue(record.created_at, "created_at"),
    base_model: stringValue(record.base_model, "base_model"),
    adapter_id: stringValue(record.adapter_id, "adapter_id"),
    adapter_uri: stringValue(record.adapter_uri, "adapter_uri"),
    adapter_artifact_hash: stringValue(record.adapter_artifact_hash, "adapter_artifact_hash"),
    package_job_id: stringValue(record.package_job_id, "package_job_id"),
    package_uri: stringValue(record.package_uri, "package_uri"),
    package_artifact_hash: stringValue(record.package_artifact_hash, "package_artifact_hash"),
    eval: parseModelPackageEval(record.eval),
    transfer: {
      protocol: stringValue((record.transfer as Record<string, unknown> | undefined)?.protocol, "transfer.protocol", true) || PROTOCOLS.artifactFetch,
      chunked: true,
      hash_verified: true,
      https_payload: false,
    },
  };
}

async function storedAdapterPath(artifactsDir: string, adapterId: string, adapterHash: string): Promise<string> {
  const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(artifactStoreManifestPath(artifactsDir, adapterId), "utf8")));
  if (manifest.artifact_hash !== adapterHash) {
    throw new Error(`stored adapter ${adapterId} hash mismatch: expected ${adapterHash}, got ${manifest.artifact_hash}`);
  }
  return manifest.artifact_uri.startsWith("file://") ? fileURLToPath(manifest.artifact_uri) : manifest.artifact_uri;
}

function fullArtifactManifest(
  manifest: TrainingArtifactManifest,
  identity: { peerId?: string; workerId?: string },
): ArtifactManifest {
  return ArtifactManifestSchema.parse({
    peer_id: identity.peerId ?? "marshall-control",
    worker_id: identity.workerId ?? "marshall-control",
    ...manifest,
  });
}

function defaultRegistryPath(outputDir: string): string {
  return join(dirname(resolve(outputDir)), "index.json");
}

function parseModelPackageEval(value: unknown): ModelPackageEval {
  if (typeof value !== "object" || value == null) {
    throw new Error("model package eval must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    job_id: stringValue(record.job_id, "eval.job_id"),
    eval_shard_id: stringValue(record.eval_shard_id, "eval.eval_shard_id"),
    examples: numberValue(record.examples, "eval.examples"),
    correct: numberValue(record.correct, "eval.correct"),
    accuracy: numberValue(record.accuracy, "eval.accuracy"),
    invalid: numberValue(record.invalid, "eval.invalid"),
    invalid_rate: numberValue(record.invalid_rate, "eval.invalid_rate"),
    score: numberValue(record.score, "eval.score"),
    metrics_path: stringValue(record.metrics_path, "eval.metrics_path"),
  };
}

function literalString<T extends string>(value: unknown, field: string, expected: T): T {
  if (value !== expected) {
    throw new Error(`invalid ${field}`);
  }
  return expected;
}

function stringValue(value: unknown, field: string, optional = false): string {
  if (typeof value !== "string" || value.length === 0) {
    if (optional) {
      return "";
    }
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function nestedValue(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value == null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[field];
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
