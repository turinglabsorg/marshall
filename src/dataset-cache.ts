import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix as pathPosix, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { TrainingJob } from "./schemas.js";

const DATASET_FILES = ["train.jsonl", "valid.jsonl", "test.jsonl", "eval.jsonl"] as const;
const INLINE_DATASETS = new Map<string, { filename: string; content: string }>([
  ["inline://tiny-italian-v1", {
    filename: "tiny-italian.jsonl",
    content: [
      "{\"text\":\"ciao mondo. marshall impara una rete leggera.\"}",
      "{\"text\":\"un worker piccolo addestra un modello minuscolo.\"}",
      "{\"text\":\"il modello predice il prossimo carattere del testo.\"}",
      "{\"text\":\"dataset piccolo, training vero, test veloce.\"}",
      "{\"text\":\"la rete p2p assegna un job e riceve un artifact.\"}",
      "",
    ].join("\n"),
  }],
]);

export interface PreparedDatasetShard {
  path: string;
  cachePath: string;
  hash: string;
  cacheHit: boolean;
}

export interface PrepareDatasetShardOptions {
  projectRoot: string;
  cacheRoot?: string;
}

export async function prepareDatasetShard(
  shard: TrainingJob["dataset_shard"],
  options: PrepareDatasetShardOptions,
): Promise<PreparedDatasetShard> {
  if (shard.uri.startsWith("inline://")) {
    return prepareInlineDatasetShard(shard, options);
  }
  if (shard.files != null && shard.files.length > 0) {
    return prepareDatasetShardFiles(shard, options);
  }
  if (isHttpUri(shard.uri)) {
    return prepareRemoteDatasetShardFile(shard, options);
  }

  const sourcePath = resolveDatasetUri(shard.uri, options.projectRoot);
  const sourceHash = await hashDatasetPath(sourcePath);
  if (sourceHash !== shard.hash) {
    throw new Error(`dataset shard hash mismatch for ${shard.id}: expected ${shard.hash}, got ${sourceHash}`);
  }

  const cacheRoot = resolve(options.cacheRoot ?? join(options.projectRoot, ".marshall/cache/datasets"));
  const cachePath = join(cacheRoot, shard.hash.replace("sha256:", ""));
  const cached = await isUsableCache(cachePath, shard.hash);
  if (cached) {
    return {
      path: await trainingPathForCache(cachePath),
      cachePath,
      hash: shard.hash,
      cacheHit: true,
    };
  }

  await mkdir(cacheRoot, { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
  await rm(tempPath, { recursive: true, force: true });
  await copyDatasetPath(sourcePath, tempPath);

  const cachedHash = await hashDatasetPath(tempPath);
  if (cachedHash !== shard.hash) {
    await rm(tempPath, { recursive: true, force: true });
    throw new Error(`cached dataset shard hash mismatch for ${shard.id}: expected ${shard.hash}, got ${cachedHash}`);
  }

  await commitCachePath(tempPath, cachePath, shard.hash);

  return {
    path: await trainingPathForCache(cachePath),
    cachePath,
    hash: shard.hash,
    cacheHit: false,
  };
}

async function prepareDatasetShardFiles(
  shard: TrainingJob["dataset_shard"],
  options: PrepareDatasetShardOptions,
): Promise<PreparedDatasetShard> {
  const cacheRoot = resolve(options.cacheRoot ?? join(options.projectRoot, ".marshall/cache/datasets"));
  const cachePath = join(cacheRoot, shard.hash.replace("sha256:", ""));
  const cached = await isUsableCache(cachePath, shard.hash);
  if (cached) {
    return {
      path: await trainingPathForCache(cachePath),
      cachePath,
      hash: shard.hash,
      cacheHit: true,
    };
  }

  await mkdir(cacheRoot, { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
  await rm(tempPath, { recursive: true, force: true });
  await mkdir(tempPath, { recursive: true });

  try {
    for (const file of shard.files ?? []) {
      const relativePath = safeDatasetRelativePath(file.path);
      const destination = resolve(tempPath, ...relativePath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await materializeDatasetFile(file.uri, destination, options.projectRoot);

      const actualHash = await hashDatasetPath(destination);
      if (actualHash !== file.sha256) {
        throw new Error(`dataset shard file hash mismatch for ${shard.id}/${relativePath}: expected ${file.sha256}, got ${actualHash}`);
      }
      if (file.bytes != null) {
        const info = await stat(destination);
        if (info.size !== file.bytes) {
          throw new Error(`dataset shard file size mismatch for ${shard.id}/${relativePath}: expected ${file.bytes}, got ${info.size}`);
        }
      }
    }

    const cachedHash = await hashDatasetPath(tempPath);
    if (cachedHash !== shard.hash) {
      throw new Error(`cached dataset shard hash mismatch for ${shard.id}: expected ${shard.hash}, got ${cachedHash}`);
    }
    await commitCachePath(tempPath, cachePath, shard.hash);
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    throw error;
  }

  return {
    path: await trainingPathForCache(cachePath),
    cachePath,
    hash: shard.hash,
    cacheHit: false,
  };
}

async function prepareRemoteDatasetShardFile(
  shard: TrainingJob["dataset_shard"],
  options: PrepareDatasetShardOptions,
): Promise<PreparedDatasetShard> {
  const cacheRoot = resolve(options.cacheRoot ?? join(options.projectRoot, ".marshall/cache/datasets"));
  const cachePath = join(cacheRoot, shard.hash.replace("sha256:", ""));
  const cached = await isUsableCache(cachePath, shard.hash);
  if (cached) {
    return {
      path: await trainingPathForCache(cachePath),
      cachePath,
      hash: shard.hash,
      cacheHit: true,
    };
  }

  await mkdir(cacheRoot, { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
  await rm(tempPath, { recursive: true, force: true });
  await mkdir(tempPath, { recursive: true });

  try {
    const remoteName = basename(new URL(shard.uri).pathname);
    const destination = join(tempPath, remoteName.endsWith(".jsonl") ? remoteName : "dataset.jsonl");
    await materializeDatasetFile(shard.uri, destination, options.projectRoot);
    const cachedHash = await hashDatasetPath(tempPath);
    if (cachedHash !== shard.hash) {
      throw new Error(`cached dataset shard hash mismatch for ${shard.id}: expected ${shard.hash}, got ${cachedHash}`);
    }
    await commitCachePath(tempPath, cachePath, shard.hash);
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    throw error;
  }

  return {
    path: await trainingPathForCache(cachePath),
    cachePath,
    hash: shard.hash,
    cacheHit: false,
  };
}

async function prepareInlineDatasetShard(
  shard: TrainingJob["dataset_shard"],
  options: PrepareDatasetShardOptions,
): Promise<PreparedDatasetShard> {
  const dataset = INLINE_DATASETS.get(shard.uri);
  if (dataset == null) {
    throw new Error(`unsupported inline dataset URI: ${shard.uri}`);
  }

  const sourceHash = sha256Text(dataset.content);
  if (sourceHash !== shard.hash) {
    throw new Error(`dataset shard hash mismatch for ${shard.id}: expected ${shard.hash}, got ${sourceHash}`);
  }

  const cacheRoot = resolve(options.cacheRoot ?? join(options.projectRoot, ".marshall/cache/datasets"));
  const cachePath = join(cacheRoot, shard.hash.replace("sha256:", ""));
  const cached = await isUsableCache(cachePath, shard.hash);
  if (cached) {
    return {
      path: await trainingPathForCache(cachePath),
      cachePath,
      hash: shard.hash,
      cacheHit: true,
    };
  }

  await mkdir(cacheRoot, { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
  await rm(tempPath, { recursive: true, force: true });
  await mkdir(tempPath, { recursive: true });
  await writeFile(join(tempPath, dataset.filename), dataset.content, "utf8");

  const cachedHash = await hashDatasetPath(tempPath);
  if (cachedHash !== shard.hash) {
    await rm(tempPath, { recursive: true, force: true });
    throw new Error(`cached dataset shard hash mismatch for ${shard.id}: expected ${shard.hash}, got ${cachedHash}`);
  }

  await commitCachePath(tempPath, cachePath, shard.hash);

  return {
    path: await trainingPathForCache(cachePath),
    cachePath,
    hash: shard.hash,
    cacheHit: false,
  };
}

export async function hashDatasetPath(path: string): Promise<string> {
  const info = await stat(path);
  if (info.isFile()) {
    const digest = createHash("sha256");
    digest.update(await readFile(path));
    return `sha256:${digest.digest("hex")}`;
  }
  if (!info.isDirectory()) {
    throw new Error(`unsupported dataset path type: ${path}`);
  }

  const digest = createHash("sha256");
  const entries = await readdir(path, { withFileTypes: true });
  const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const names = DATASET_FILES.filter((name) => fileNames.has(name));

  if (names.length === 1 && fileNames.size === 1) {
    return hashDatasetPath(join(path, names[0]));
  }

  if (names.length === 0) {
    const jsonlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
    if (jsonlFiles.length === 1) {
      return hashDatasetPath(join(path, jsonlFiles[0].name));
    }
    throw new Error(`dataset directory has no JSONL split files: ${path}`);
  }

  for (const name of names) {
    const content = await readFile(join(path, name));
    digest.update(`file\0${name}\0${content.byteLength}\0`);
    digest.update(content);
  }
  return `sha256:${digest.digest("hex")}`;
}

function resolveDatasetUri(uri: string, projectRoot: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`unsupported dataset URI for local cache prototype: ${uri}`);
  }

  const path = uri.slice("file://".length);
  if (path.startsWith("/")) {
    return fileURLToPath(uri);
  }
  return resolve(projectRoot, path);
}

async function materializeDatasetFile(uri: string, destination: string, projectRoot: string): Promise<void> {
  if (uri.startsWith("file://")) {
    await cp(resolveDatasetUri(uri, projectRoot), destination);
    return;
  }
  if (!isHttpUri(uri)) {
    throw new Error(`unsupported dataset file URI: ${uri}`);
  }

  const response = await fetch(uri);
  if (!response.ok || response.body == null) {
    throw new Error(`dataset download failed for ${uri}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function copyDatasetPath(sourcePath: string, targetPath: string): Promise<void> {
  const info = await stat(sourcePath);
  if (info.isFile()) {
    await mkdir(targetPath, { recursive: true });
    await cp(sourcePath, join(targetPath, basename(sourcePath)));
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`unsupported dataset path type: ${sourcePath}`);
  }

  await mkdir(targetPath, { recursive: true });
  for (const name of DATASET_FILES) {
    const sourceFile = join(sourcePath, name);
    try {
      const fileInfo = await stat(sourceFile);
      if (fileInfo.isFile()) {
        await cp(sourceFile, join(targetPath, name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function isUsableCache(cachePath: string, expectedHash: string): Promise<boolean> {
  try {
    return await hashDatasetPath(cachePath) === expectedHash;
  } catch {
    return false;
  }
}

async function commitCachePath(tempPath: string, cachePath: string, expectedHash: string): Promise<void> {
  try {
    await rename(tempPath, cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
      await rm(tempPath, { recursive: true, force: true });
      throw error;
    }

    await rm(tempPath, { recursive: true, force: true });
    if (!(await isUsableCache(cachePath, expectedHash))) {
      await rm(cachePath, { recursive: true, force: true });
      throw new Error(`dataset cache collision at ${cachePath}`);
    }
  }
}

async function trainingPathForCache(cachePath: string): Promise<string> {
  const entries = await readdir(cachePath, { withFileTypes: true });
  const fileEntries = entries.filter((entry) => entry.isFile());
  const jsonlFiles = fileEntries.filter((entry) => entry.name.endsWith(".jsonl"));
  if (jsonlFiles.length === 1 && fileEntries.length === 1) {
    return join(cachePath, jsonlFiles[0].name);
  }
  return cachePath;
}

function sha256Text(content: string): string {
  const digest = createHash("sha256");
  digest.update(content, "utf8");
  return `sha256:${digest.digest("hex")}`;
}

function isHttpUri(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function safeDatasetRelativePath(value: string): string {
  if (value.includes("\0") || value.startsWith("/") || value === "." || value === "..") {
    throw new Error(`invalid dataset file path: ${value}`);
  }
  const normalized = pathPosix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`invalid dataset file path: ${value}`);
  }
  return value;
}
