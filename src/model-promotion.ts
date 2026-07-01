import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Path } from "./artifact-transfer.js";
import {
  modelArtifactUri,
  parseOptimizedModelPackage,
  safeModelPathSegment,
  type OptimizedModelPackage,
} from "./model-package.js";
import type { WorkerPeer } from "./worker-peer.js";

export interface PromoteModelPackageOptions {
  worker: WorkerPeer;
  packageJobId: string;
  packageArtifactHash: string;
  outputRoot: string;
  packageName?: string;
  adapterId?: string;
  adapterArtifactHash?: string;
  chunkBytes?: number;
  maxChunkRetries?: number;
}

export interface PromoteModelPackageResult {
  type: "marshall_model_package_promoted";
  package_job_id: string;
  package_artifact_hash: string;
  source_package_path: string;
  adapter_id: string;
  adapter_artifact_hash: string;
  adapter_path: string;
  model_package_path: string;
  output_dir: string;
}

export async function promoteModelPackageFromControl(options: PromoteModelPackageOptions): Promise<PromoteModelPackageResult> {
  const fetchedArtifactsRoot = join(options.outputRoot, "artifacts");
  const packageManifest = await options.worker.fetchArtifactFromControl(
    options.packageJobId,
    options.packageArtifactHash,
    fetchedArtifactsRoot,
    {
      chunkBytes: options.chunkBytes,
      maxChunkRetries: options.maxChunkRetries,
    },
  );
  const packagePath = fileURLToPath(packageManifest.artifact_uri);
  const sourcePackage = parseOptimizedModelPackage(JSON.parse(await readFile(packagePath, "utf8")));
  const adapterId = options.adapterId ?? sourcePackage.adapter_id;
  const adapterArtifactHash = options.adapterArtifactHash ?? sourcePackage.adapter_artifact_hash;
  const adapterManifest = await options.worker.fetchArtifactFromControl(
    adapterId,
    adapterArtifactHash,
    fetchedArtifactsRoot,
    {
      chunkBytes: options.chunkBytes,
      maxChunkRetries: options.maxChunkRetries,
    },
  );
  const adapterPath = fileURLToPath(adapterManifest.artifact_uri);
  const actualAdapterHash = await sha256Path(adapterPath);
  if (actualAdapterHash !== adapterArtifactHash) {
    throw new Error(`promoted adapter hash mismatch: expected ${adapterArtifactHash}, got ${actualAdapterHash}`);
  }

  const promotedPackage: OptimizedModelPackage = {
    ...sourcePackage,
    adapter_id: adapterId,
    adapter_uri: modelArtifactUri(adapterId),
    adapter_path: adapterPath,
    adapter_artifact_hash: adapterArtifactHash,
  };
  const outputDir = join(options.outputRoot, "ready", safeModelPathSegment(options.packageName ?? promotedPackage.run_id ?? options.packageJobId));
  const modelPackagePath = join(outputDir, "model_package.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(modelPackagePath, JSON.stringify(promotedPackage, null, 2) + "\n", "utf8");
  await writeFile(join(outputDir, "promotion.json"), JSON.stringify({
    type: "marshall_model_package_promotion",
    package_job_id: options.packageJobId,
    package_artifact_hash: options.packageArtifactHash,
    source_package_manifest: packageManifest,
    adapter_manifest: adapterManifest,
  }, null, 2) + "\n", "utf8");

  return {
    type: "marshall_model_package_promoted",
    package_job_id: options.packageJobId,
    package_artifact_hash: options.packageArtifactHash,
    source_package_path: packagePath,
    adapter_id: adapterId,
    adapter_artifact_hash: adapterArtifactHash,
    adapter_path: adapterPath,
    model_package_path: modelPackagePath,
    output_dir: dirname(modelPackagePath),
  };
}
