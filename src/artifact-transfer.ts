import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix as pathPosix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ArtifactFetchChunkResponseSchema,
  ArtifactFetchManifestResponseSchema,
  ArtifactManifestSchema,
  type ArtifactBundleFile,
  type ArtifactFetchChunkRequest,
  type ArtifactFetchChunkResponse,
  type ArtifactFetchManifestResponse,
  type ArtifactManifest,
} from "./schemas.js";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHUNK_RETRIES = 3;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

export interface ArtifactBundle {
  manifest: ArtifactManifest;
  job_id: string;
  artifact_hash: string;
  artifact_path: string;
  metrics_path?: string;
  files: ArtifactBundleFile[];
  sources: Map<string, string>;
}

export interface StoreFetchedArtifactOptions {
  manifest: ArtifactManifest;
  bundle: ArtifactFetchManifestResponse;
  outputRoot: string;
  fetchChunk: (request: Omit<ArtifactFetchChunkRequest, "auth_token">) => Promise<ArtifactFetchChunkResponse>;
  chunkBytes?: number;
  maxChunkRetries?: number;
}

export async function createArtifactBundle(manifest: ArtifactManifest, projectRoot = process.cwd()): Promise<ArtifactBundle> {
  const artifactRoot = resolveArtifactUri(manifest.artifact_uri, projectRoot);
  const artifactInfo = await stat(artifactRoot);
  const files: ArtifactBundleFile[] = [];
  const sources = new Map<string, string>();
  let artifactPath: string;

  if (artifactInfo.isFile()) {
    artifactPath = safeBundlePath(joinBundlePath("artifact", basename(artifactRoot)));
    await addBundleFile(files, sources, artifactPath, artifactRoot);
  } else if (artifactInfo.isDirectory()) {
    artifactPath = "artifact";
    const artifactFiles = await listDirectoryFiles(artifactRoot);
    for (const sourcePath of artifactFiles) {
      const rel = relative(artifactRoot, sourcePath).replaceAll("\\", "/");
      await addBundleFile(files, sources, safeBundlePath(joinBundlePath("artifact", rel)), sourcePath);
    }
  } else {
    throw new Error(`unsupported artifact path: ${artifactRoot}`);
  }

  const metricsPath = manifest.metrics_uri == null
    ? undefined
    : await bundleMetricsPath(manifest.metrics_uri, artifactRoot, artifactInfo.isDirectory(), artifactPath, files, sources, projectRoot);

  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    manifest,
    job_id: manifest.job_id,
    artifact_hash: manifest.artifact_hash,
    artifact_path: artifactPath,
    metrics_path: metricsPath,
    files,
    sources,
  };
}

export async function artifactBundleManifestResponse(bundle: ArtifactBundle): Promise<ArtifactFetchManifestResponse> {
  return ArtifactFetchManifestResponseSchema.parse({
    response_type: "manifest",
    accepted: true,
    job_id: bundle.job_id,
    artifact_hash: bundle.artifact_hash,
    artifact_path: bundle.artifact_path,
    metrics_path: bundle.metrics_path,
    manifest: bundle.manifest,
    files: bundle.files,
  });
}

export async function readArtifactBundleChunk(
  bundle: ArtifactBundle,
  request: ArtifactFetchChunkRequest,
): Promise<ArtifactFetchChunkResponse> {
  if (request.job_id !== bundle.job_id || request.artifact_hash !== bundle.artifact_hash) {
    return ArtifactFetchChunkResponseSchema.parse({
      response_type: "chunk",
      accepted: false,
      reason: "artifact request does not match bundle",
    });
  }

  const requestedPath = safeBundlePath(request.path);
  const file = bundle.files.find((item) => item.path === requestedPath);
  const sourcePath = bundle.sources.get(requestedPath);
  if (file == null || sourcePath == null) {
    return ArtifactFetchChunkResponseSchema.parse({
      response_type: "chunk",
      accepted: false,
      reason: "artifact file not found",
    });
  }
  if (request.offset >= file.bytes && file.bytes > 0) {
    return ArtifactFetchChunkResponseSchema.parse({
      response_type: "chunk",
      accepted: false,
      reason: "chunk offset is outside file",
    });
  }

  const length = Math.min(request.length, MAX_CHUNK_BYTES, Math.max(0, file.bytes - request.offset));
  const handle = await open(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, request.offset);
    const data = buffer.subarray(0, result.bytesRead);
    return ArtifactFetchChunkResponseSchema.parse({
      response_type: "chunk",
      accepted: true,
      job_id: bundle.job_id,
      artifact_hash: bundle.artifact_hash,
      path: requestedPath,
      offset: request.offset,
      bytes: data.byteLength,
      chunk_hash: sha256Buffer(data),
      data_base64: data.toString("base64"),
    });
  } finally {
    await handle.close();
  }
}

export async function storeFetchedArtifact(options: StoreFetchedArtifactOptions): Promise<ArtifactManifest> {
  const bundle = options.bundle;
  if (!bundle.accepted) {
    throw new Error(`artifact fetch rejected: ${bundle.reason ?? "unknown reason"}`);
  }
  if (bundle.job_id !== options.manifest.job_id || bundle.artifact_hash !== options.manifest.artifact_hash) {
    throw new Error("artifact bundle does not match manifest");
  }

  const chunkBytes = normalizedChunkBytes(options.chunkBytes);
  const maxChunkRetries = options.maxChunkRetries ?? DEFAULT_MAX_CHUNK_RETRIES;
  const outputRoot = resolve(options.outputRoot);
  const jobRoot = resolve(outputRoot, safePathSegment(options.manifest.job_id));
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(jobRoot, { recursive: true });

  for (const file of bundle.files) {
    const bundlePath = safeBundlePath(file.path);
    const destination = destinationPath(jobRoot, bundlePath);
    await mkdir(dirname(destination), { recursive: true });
    if (file.bytes === 0) {
      await writeFile(destination, "");
    } else {
      const handle = await open(destination, "w");
      try {
        let offset = 0;
        while (offset < file.bytes) {
          const length = Math.min(chunkBytes, file.bytes - offset);
          const chunk = await fetchVerifiedChunk(options, bundlePath, offset, length, maxChunkRetries);
          await handle.write(chunk, 0, chunk.byteLength, offset);
          offset += chunk.byteLength;
        }
      } finally {
        await handle.close();
      }
    }

    const actualFileHash = await sha256File(destination);
    if (actualFileHash !== file.sha256) {
      throw new Error(`downloaded artifact file hash mismatch for ${bundlePath}: expected ${file.sha256}, got ${actualFileHash}`);
    }
    const info = await stat(destination);
    if (info.size !== file.bytes) {
      throw new Error(`downloaded artifact file size mismatch for ${bundlePath}: expected ${file.bytes}, got ${info.size}`);
    }
  }

  const artifactPath = destinationPath(jobRoot, safeBundlePath(bundle.artifact_path));
  if (!bundle.files.some((file) => file.path === bundle.artifact_path)) {
    await mkdir(artifactPath, { recursive: true });
  }
  const artifactHash = await sha256Path(artifactPath);
  if (artifactHash !== options.manifest.artifact_hash) {
    throw new Error(`downloaded artifact hash mismatch: expected ${options.manifest.artifact_hash}, got ${artifactHash}`);
  }

  const metricsPath = bundle.metrics_path == null
    ? undefined
    : destinationPath(jobRoot, safeBundlePath(bundle.metrics_path));
  const storedManifest = ArtifactManifestSchema.parse({
    ...options.manifest,
    artifact_uri: pathToFileURL(artifactPath).toString(),
    metrics_uri: metricsPath == null ? undefined : pathToFileURL(metricsPath).toString(),
  });
  await writeFile(join(jobRoot, "manifest.json"), JSON.stringify(storedManifest, null, 2) + "\n", "utf8");
  return storedManifest;
}

export async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

export async function sha256Path(path: string): Promise<string> {
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

export function sha256Buffer(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedChunkBytes(value: number | undefined): number {
  const parsed = value ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CHUNK_BYTES) {
    throw new Error(`invalid artifact chunk size: ${parsed}`);
  }
  return parsed;
}

async function fetchVerifiedChunk(
  options: StoreFetchedArtifactOptions,
  path: string,
  offset: number,
  length: number,
  maxChunkRetries: number,
): Promise<Buffer> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxChunkRetries; attempt += 1) {
    try {
      const response = await options.fetchChunk({
        request_type: "chunk",
        job_id: options.manifest.job_id,
        artifact_hash: options.manifest.artifact_hash,
        path,
        offset,
        length,
      });
      if (!response.accepted) {
        throw new Error(response.reason ?? "artifact chunk fetch rejected");
      }
      if (
        response.job_id !== options.manifest.job_id
        || response.artifact_hash !== options.manifest.artifact_hash
        || response.path !== path
        || response.offset !== offset
      ) {
        throw new Error("artifact chunk response does not match request");
      }
      const data = Buffer.from(response.data_base64, "base64");
      if (data.byteLength !== response.bytes) {
        throw new Error(`artifact chunk byte count mismatch for ${path}@${offset}`);
      }
      if (data.byteLength > length) {
        throw new Error(`artifact chunk exceeded requested length for ${path}@${offset}`);
      }
      const actualChunkHash = sha256Buffer(data);
      if (actualChunkHash !== response.chunk_hash) {
        throw new Error(`artifact chunk hash mismatch for ${path}@${offset}`);
      }
      if (data.byteLength === 0 && length > 0) {
        throw new Error(`artifact chunk was empty for ${path}@${offset}`);
      }
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error(`artifact chunk fetch failed for ${path}@${offset}`);
}

async function bundleMetricsPath(
  metricsUri: string,
  artifactRoot: string,
  artifactIsDirectory: boolean,
  artifactPath: string,
  files: ArtifactBundleFile[],
  sources: Map<string, string>,
  projectRoot: string,
): Promise<string> {
  const metricsSource = resolveArtifactUri(metricsUri, projectRoot);
  if (artifactIsDirectory) {
    const rel = relative(artifactRoot, metricsSource).replaceAll("\\", "/");
    if (rel !== "" && !rel.startsWith("../") && rel !== ".." && !rel.startsWith("/")) {
      return safeBundlePath(joinBundlePath(artifactPath, rel));
    }
  } else if (metricsSource === artifactRoot) {
    return artifactPath;
  }

  const metricsPath = safeBundlePath(joinBundlePath("metrics", basename(metricsSource)));
  await addBundleFile(files, sources, metricsPath, metricsSource);
  return metricsPath;
}

async function addBundleFile(
  files: ArtifactBundleFile[],
  sources: Map<string, string>,
  bundlePath: string,
  sourcePath: string,
): Promise<void> {
  if (sources.has(bundlePath)) {
    return;
  }
  const info = await stat(sourcePath);
  if (!info.isFile()) {
    throw new Error(`artifact bundle source is not a file: ${sourcePath}`);
  }
  sources.set(bundlePath, sourcePath);
  files.push({
    path: bundlePath,
    bytes: info.size,
    sha256: await sha256File(sourcePath),
  });
}

async function listDirectoryFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  await collectDirectoryFiles(root, output);
  output.sort((left, right) => left.localeCompare(right));
  return output;
}

async function collectDirectoryFiles(current: string, output: string[]): Promise<void> {
  const entries = (await readdir(current, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectDirectoryFiles(path, output);
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
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

function resolveArtifactUri(uri: string, projectRoot: string): string {
  if (uri.startsWith("file://")) {
    const path = fileURLToPath(uri);
    return path.startsWith("/") ? path : resolve(projectRoot, path);
  }
  return uri.startsWith("/") ? uri : resolve(projectRoot, uri);
}

function destinationPath(root: string, bundlePath: string): string {
  const destination = resolve(root, ...safeBundlePath(bundlePath).split("/"));
  if (destination !== root && !destination.startsWith(`${root}/`)) {
    throw new Error(`artifact bundle path escapes output root: ${bundlePath}`);
  }
  return destination;
}

export function artifactStoreManifestPath(outputRoot: string, jobId: string): string {
  return join(resolve(outputRoot), safePathSegment(jobId), "manifest.json");
}

function safeBundlePath(value: string): string {
  if (value.includes("\0") || value.startsWith("/") || value === "." || value === "..") {
    throw new Error(`invalid artifact bundle path: ${value}`);
  }
  const normalized = pathPosix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`invalid artifact bundle path: ${value}`);
  }
  return value;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "artifact";
}

function joinBundlePath(...values: string[]): string {
  return values.join("/").replaceAll(/\/+/g, "/");
}
