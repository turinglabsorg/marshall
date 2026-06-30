import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactBundleManifestResponse,
  createArtifactBundle,
  readArtifactBundleChunk,
  sha256Path,
  storeFetchedArtifact,
} from "../src/artifact-transfer.js";
import { ArtifactManifestSchema } from "../src/schemas.js";

describe("artifact transfer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-artifact-transfer-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("retries corrupted chunks and verifies the final artifact hash", async () => {
    const sourceDir = join(tempDir, "source-artifact");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "weights.bin"), "0123456789abcdefghijklmnopqrstuvwxyz", "utf8");
    await writeFile(join(sourceDir, "config.json"), "{\"rank\":2}\n", "utf8");

    const manifest = ArtifactManifestSchema.parse({
      peer_id: "peer_test",
      worker_id: "worker_test",
      job_id: "job_transfer_retry",
      artifact_type: "lora_adapter",
      artifact_uri: pathToFileURL(sourceDir).toString(),
      artifact_hash: await sha256Path(sourceDir),
      config_hash: "sha256:config",
      created_at: new Date().toISOString(),
    });
    const bundle = await createArtifactBundle(manifest);
    const bundleResponse = await artifactBundleManifestResponse(bundle);
    let corrupted = false;
    let corruptedPath: string | undefined;
    let firstChunkAttempts = 0;

    const stored = await storeFetchedArtifact({
      manifest,
      bundle: bundleResponse,
      outputRoot: join(tempDir, "store"),
      chunkBytes: 8,
      maxChunkRetries: 2,
      fetchChunk: async (request) => {
        const response = await readArtifactBundleChunk(bundle, request);
        if (response.accepted && request.offset === 0 && !corrupted) {
          corrupted = true;
          corruptedPath = request.path;
          firstChunkAttempts += 1;
          return { ...response, chunk_hash: "sha256:corrupted" };
        }
        if (request.offset === 0 && request.path === corruptedPath) {
          firstChunkAttempts += 1;
        }
        return response;
      },
    });

    expect(firstChunkAttempts).toBe(2);
    expect(await sha256Path(fileURLToPath(stored.artifact_uri))).toBe(manifest.artifact_hash);
  });
});
