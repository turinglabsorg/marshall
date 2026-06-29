import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { TrainingJob } from "./schemas.js";

const DATASET_FILES = ["train.jsonl", "valid.jsonl", "test.jsonl", "eval.jsonl"] as const;

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
    return {
      path: shard.uri,
      cachePath: shard.uri,
      hash: shard.hash,
      cacheHit: true,
    };
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

  try {
    await rename(tempPath, cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
      await rm(tempPath, { recursive: true, force: true });
      throw error;
    }

    await rm(tempPath, { recursive: true, force: true });
    if (!(await isUsableCache(cachePath, shard.hash))) {
      await rm(cachePath, { recursive: true, force: true });
      await copyDatasetPath(sourcePath, tempPath);
      await rename(tempPath, cachePath);
    }
  }

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
  return path.startsWith("/") ? path : resolve(projectRoot, path);
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

async function trainingPathForCache(cachePath: string): Promise<string> {
  const entries = await readdir(cachePath, { withFileTypes: true });
  const fileEntries = entries.filter((entry) => entry.isFile());
  const jsonlFiles = fileEntries.filter((entry) => entry.name.endsWith(".jsonl"));
  if (jsonlFiles.length === 1 && !fileEntries.some((entry) => DATASET_FILES.includes(entry.name as (typeof DATASET_FILES)[number]))) {
    return join(cachePath, jsonlFiles[0].name);
  }
  return cachePath;
}
