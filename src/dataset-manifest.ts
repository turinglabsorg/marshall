import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashDatasetPath } from "./dataset-cache.js";

export interface BuildDatasetManifestOptions {
  inputJsonl: string[];
  outputDir: string;
  datasetId: string;
  version: string;
  schema: string;
  license: string;
  shardCount: number;
  validEvery: number;
  textField: string;
  maxRecords?: number;
  instructionField?: string;
  responseField?: string;
  contextField?: string;
  systemPrompt?: string;
  baseUri?: string;
}

export interface DatasetManifestBuildResult {
  type: "marshall_dataset_manifest_created";
  output_dir: string;
  manifest_path: string;
  dataset_id: string;
  version: string;
  records: number;
  shards: number;
  token_estimate: number;
  base_uri: string | null;
}

export async function buildDatasetManifest(options: BuildDatasetManifestOptions): Promise<DatasetManifestBuildResult> {
  if (options.inputJsonl.length === 0) {
    throw new Error("at least one input JSONL is required");
  }
  if ((options.instructionField == null) !== (options.responseField == null)) {
    throw new Error("instructionField and responseField must be set together");
  }

  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const shards = Array.from({ length: options.shardCount }, () => ({
    train: [] as string[],
    valid: [] as string[],
  }));

  let records = 0;
  for (const input of options.inputJsonl) {
    const lines = (await readFile(input, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      const normalized = normalizeRecord(JSON.parse(line), options);
      const shardIndex = records % options.shardCount;
      const split = records % options.validEvery === 0 ? "valid" : "train";
      shards[shardIndex][split].push(JSON.stringify(normalized) + "\n");
      records += 1;
      if (options.maxRecords != null && records >= options.maxRecords) {
        break;
      }
    }
    if (options.maxRecords != null && records >= options.maxRecords) {
      break;
    }
  }

  if (records === 0) {
    throw new Error("dataset input produced no records");
  }

  const manifestShards = [];
  for (let index = 0; index < shards.length; index += 1) {
    const shard = shards[index];
    const shardName = `shard-${String(index + 1).padStart(6, "0")}`;
    const shardDir = join(outputDir, "shards", shardName);
    await mkdir(shardDir, { recursive: true });
    const files: Array<{ path: string; uri: string; sha256: string; bytes: number }> = [];
    if (shard.train.length > 0) {
      files.push(await writeShardFile(shardDir, shardName, "train.jsonl", shard.train.join(""), options.baseUri));
    }
    if (shard.valid.length > 0) {
      files.push(await writeShardFile(shardDir, shardName, "valid.jsonl", shard.valid.join(""), options.baseUri));
    }
    if (files.length === 0) {
      continue;
    }

    manifestShards.push({
      shard_id: `${options.datasetId}_shard_${String(index + 1).padStart(6, "0")}`,
      split: "train_valid",
      uri: shardUri(shardDir, shardName, options.baseUri),
      sha256: await hashDatasetPath(shardDir),
      token_estimate: estimateTokens([...shard.train, ...shard.valid]),
      files,
    });
  }

  if (manifestShards.length === 0) {
    throw new Error("dataset input produced no non-empty shards");
  }

  const manifest = {
    dataset_id: options.datasetId,
    version: options.version,
    license: options.license,
    visibility: options.baseUri == null ? "local-private-test" : "external-addressable",
    schema: options.schema,
    root_uri: manifestShards[0].uri,
    root_hash: manifestShards[0].sha256,
    token_estimate: manifestShards.reduce((total, shard) => total + shard.token_estimate, 0),
    source_files: await Promise.all(options.inputJsonl.map(async (path) => ({
      path,
      bytes: await fileSize(path),
    }))),
    sharding: {
      shard_count: manifestShards.length,
      valid_every: options.validEvery,
      max_records: options.maxRecords ?? null,
      text_field: options.textField,
      instruction_field: options.instructionField ?? null,
      response_field: options.responseField ?? null,
      context_field: options.contextField ?? null,
      transform: options.instructionField == null ? "text" : "instruction_response",
    },
    notes: "Generated local manifest for private Marshall dataset runs. Generated data stays outside the repository.",
    shards: manifestShards,
  };

  const manifestPath = join(outputDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    type: "marshall_dataset_manifest_created",
    output_dir: outputDir,
    manifest_path: manifestPath,
    dataset_id: options.datasetId,
    version: options.version,
    records,
    shards: manifestShards.length,
    token_estimate: manifest.token_estimate,
    base_uri: options.baseUri ?? null,
  };
}

async function writeShardFile(
  shardDir: string,
  shardName: string,
  filename: "train.jsonl" | "valid.jsonl",
  content: string,
  publishBaseUri: string | undefined,
): Promise<{ path: string; uri: string; sha256: string; bytes: number }> {
  const path = join(shardDir, filename);
  await writeFile(path, content, "utf8");
  const info = await stat(path);
  return {
    path: filename,
    uri: publishBaseUri == null ? pathToFileURL(path).toString() : `${publishBaseUri}/shards/${shardName}/${filename}`,
    sha256: sha256Text(content),
    bytes: info.size,
  };
}

function normalizeRecord(value: unknown, options: BuildDatasetManifestOptions): unknown {
  if (typeof value !== "object" || value == null) {
    throw new Error("dataset record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    return record;
  }
  if (options.instructionField != null && options.responseField != null) {
    return normalizeInstructionRecord(record, options);
  }
  const text = record[options.textField];
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error(`dataset record missing text field: ${options.textField}`);
  }
  return {
    messages: [
      { role: "user", content: "Continue the document." },
      { role: "assistant", content: text.trim() },
    ],
  };
}

function normalizeInstructionRecord(record: Record<string, unknown>, options: BuildDatasetManifestOptions): unknown {
  const instruction = requiredStringField(record, options.instructionField ?? "instruction");
  const response = requiredStringField(record, options.responseField ?? "response");
  const context = options.contextField == null ? undefined : optionalStringField(record, options.contextField);
  const userContent = context == null ? instruction : `${instruction}\n\nContext:\n${context}`;
  const messages = [];
  if (options.systemPrompt != null) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push(
    { role: "user", content: userContent },
    { role: "assistant", content: response },
  );
  return { messages };
}

function requiredStringField(record: Record<string, unknown>, field: string): string {
  const value = optionalStringField(record, field);
  if (value == null) {
    throw new Error(`dataset record missing text field: ${field}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function estimateTokens(values: string[]): number {
  const chars = values.reduce((total, value) => total + value.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

function shardUri(shardDir: string, shardName: string, publishBaseUri: string | undefined): string {
  return publishBaseUri == null ? pathToFileURL(shardDir).toString() : `${publishBaseUri}/shards/${shardName}`;
}

function sha256Text(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
