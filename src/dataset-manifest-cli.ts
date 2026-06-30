import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashDatasetPath } from "./dataset-cache.js";

const args = parseArgs(process.argv.slice(2));
const inputJsonl = splitList(args["input-jsonl"] ?? process.env.MARSHALL_DATASET_INPUT_JSONL ?? "");
if (inputJsonl.length === 0) {
  throw new Error("--input-jsonl or MARSHALL_DATASET_INPUT_JSONL is required");
}

const outputDir = resolve(args["output-dir"] ?? process.env.MARSHALL_DATASET_OUTPUT_DIR ?? ".marshall/datasets/manifest");
const datasetId = args["dataset-id"] ?? process.env.MARSHALL_DATASET_ID ?? "marshall-external-jsonl";
const version = args.version ?? process.env.MARSHALL_DATASET_VERSION ?? new Date().toISOString().slice(0, 10);
const schema = args.schema ?? process.env.MARSHALL_DATASET_SCHEMA ?? "mlx-chat-jsonl";
const license = args.license ?? process.env.MARSHALL_DATASET_LICENSE ?? "external-local-test";
const shardCount = positiveIntegerArg(args["shard-count"] ?? process.env.MARSHALL_DATASET_SHARD_COUNT, 8);
const validEvery = positiveIntegerArg(args["valid-every"] ?? process.env.MARSHALL_DATASET_VALID_EVERY, 20);
const maxRecords = optionalPositiveIntegerArg(args["max-records"] ?? process.env.MARSHALL_DATASET_MAX_RECORDS);
const textField = args["text-field"] ?? process.env.MARSHALL_DATASET_TEXT_FIELD ?? "text";
const baseUri = trimTrailingSlash(args["base-uri"] ?? process.env.MARSHALL_DATASET_BASE_URI);

await mkdir(outputDir, { recursive: true });
const shards = Array.from({ length: shardCount }, () => ({
  train: [] as string[],
  valid: [] as string[],
}));

let records = 0;
for (const input of inputJsonl) {
  const lines = (await readFile(input, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const normalized = normalizeRecord(JSON.parse(line), textField);
    const shardIndex = records % shardCount;
    const split = records % validEvery === 0 ? "valid" : "train";
    shards[shardIndex][split].push(JSON.stringify(normalized) + "\n");
    records += 1;
    if (maxRecords != null && records >= maxRecords) {
      break;
    }
  }
  if (maxRecords != null && records >= maxRecords) {
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
    files.push(await writeShardFile(shardDir, shardName, "train.jsonl", shard.train.join(""), baseUri));
  }
  if (shard.valid.length > 0) {
    files.push(await writeShardFile(shardDir, shardName, "valid.jsonl", shard.valid.join(""), baseUri));
  }
  if (files.length === 0) {
    continue;
  }

  manifestShards.push({
    shard_id: `${datasetId}_shard_${String(index + 1).padStart(6, "0")}`,
    split: "train_valid",
    uri: shardUri(shardDir, shardName, baseUri),
    sha256: await hashDatasetPath(shardDir),
    token_estimate: estimateTokens([...shard.train, ...shard.valid]),
    files,
  });
}

if (manifestShards.length === 0) {
  throw new Error("dataset input produced no non-empty shards");
}

const manifest = {
  dataset_id: datasetId,
  version,
  license,
  visibility: baseUri == null ? "local-private-test" : "external-addressable",
  schema,
  root_uri: manifestShards[0].uri,
  root_hash: manifestShards[0].sha256,
  token_estimate: manifestShards.reduce((total, shard) => total + shard.token_estimate, 0),
  source_files: inputJsonl.map((path) => ({
    path,
    bytes: fileSize(path),
  })),
  sharding: {
    shard_count: manifestShards.length,
    valid_every: validEvery,
    max_records: maxRecords ?? null,
    text_field: textField,
  },
  notes: "Generated local manifest for private Marshall dataset runs. Generated data stays outside the repository.",
  shards: manifestShards,
};

const manifestPath = join(outputDir, "manifest.json");
await writeFile(manifestPath, JSON.stringify({
  ...manifest,
  source_files: await Promise.all(manifest.source_files.map(async (source) => ({
    ...source,
    bytes: await source.bytes,
  }))),
}, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  type: "marshall_dataset_manifest_created",
  output_dir: outputDir,
  manifest_path: manifestPath,
  dataset_id: datasetId,
  version,
  records,
  shards: manifestShards.length,
  token_estimate: manifest.token_estimate,
  base_uri: baseUri ?? null,
}, null, 2));

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

function normalizeRecord(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value == null) {
    throw new Error("dataset record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    return record;
  }
  const text = record[field];
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error(`dataset record missing text field: ${field}`);
  }
  return {
    messages: [
      { role: "user", content: "Continue the document." },
      { role: "assistant", content: text.trim() },
    ],
  };
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

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return value.replace(/\/+$/, "");
}

function positiveIntegerArg(value: string | undefined, fallback: number): number {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value ?? fallback}`);
  }
  return parsed;
}

function optionalPositiveIntegerArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return positiveIntegerArg(value, 1);
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
