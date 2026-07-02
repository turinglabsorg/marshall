import { hostname } from "node:os";
import { resolveControlMultiaddrs } from "./control-network.js";
import { InferenceWorkerPeer } from "./inference-worker.js";
import { promoteModelPackageFromControl } from "./model-promotion.js";
import { loadModelRegistrySource, selectModelRegistryEntry } from "./model-package.js";
import { WorkerPeer } from "./worker-peer.js";

const args = parseArgs(process.argv.slice(2));
const privateKeyPath = requiredArg(args.key ?? process.env.MARSHALL_INFERENCE_KEY, "--key");
const modelPackage = await resolveModelPackagePath(args, privateKeyPath);
const worker = await InferenceWorkerPeer.create({
  privateKeyPath,
  listen: splitList(args.listen ?? process.env.MARSHALL_INFERENCE_LISTEN ?? "/ip4/0.0.0.0/tcp/8788"),
  workerId: args["worker-id"] ?? process.env.MARSHALL_INFERENCE_WORKER_ID,
  publicDir: args["public-dir"] ?? process.env.MARSHALL_CHAT_PUBLIC_DIR,
  runnerPath: args.runner ?? process.env.MARSHALL_CHAT_RUNNER,
  pythonBin: args.python ?? process.env.MARSHALL_PYTHON ?? "python3",
  modelPackagePath: modelPackage,
  model: args.model ?? process.env.MARSHALL_MODEL,
  adapterPath: args["adapter-path"] ?? process.env.MARSHALL_ADAPTER_PATH,
  adapterArtifactHash: args["adapter-hash"] ?? process.env.MARSHALL_ADAPTER_HASH,
  adapterId: args["adapter-id"] ?? process.env.MARSHALL_ADAPTER_ID,
  systemPrompt: args["system-prompt"] ?? process.env.MARSHALL_CHAT_SYSTEM_PROMPT ?? "You are Marshall, a concise assistant running on a permissionless distributed inference prototype.",
  maxTokens: positiveIntegerArg(args["max-tokens"] ?? process.env.MARSHALL_CHAT_MAX_TOKENS ?? "160"),
  temperature: numberArg(args.temperature ?? process.env.MARSHALL_CHAT_TEMPERATURE ?? "0.2"),
});

console.log(JSON.stringify({
  type: "marshall_inference_worker_started",
  peer_id: worker.peerId,
  addrs: worker.multiaddrs.map((addr) => addr.toString()),
  worker_id: args["worker-id"] ?? process.env.MARSHALL_INFERENCE_WORKER_ID ?? null,
  model: worker.config.model,
  adapter_id: worker.config.adapterId,
  adapter_hash: worker.config.adapterArtifactHash,
}, null, 2));

await waitForShutdown(async () => {
  await worker.stop();
});

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

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function resolveModelPackagePath(args: Record<string, string>, privateKeyPath: string): Promise<string | undefined> {
  const configuredPackage = args["model-package"] ?? args.package ?? process.env.MARSHALL_MODEL_PACKAGE;
  if (configuredPackage != null && configuredPackage !== "") {
    return configuredPackage;
  }
  const registryPath = args["model-registry-path"] ?? process.env.MARSHALL_MODEL_REGISTRY_PATH;
  const registryUrl = args["model-registry-url"] ?? process.env.MARSHALL_MODEL_REGISTRY_URL;
  const controlAddr = args.control ?? process.env.MARSHALL_CONTROL_ADDR;
  const controlNetworkPath = args["control-network-path"] ?? process.env.MARSHALL_CONTROL_NETWORK_PATH;
  const controlNetworkUrl = args["control-network-url"] ?? process.env.MARSHALL_CONTROL_NETWORK_URL;
  if ((registryPath == null || registryPath === "") && (registryUrl == null || registryUrl === "")) {
    return undefined;
  }
  if (
    (controlAddr == null || controlAddr === "")
    && (args["control-addrs"] ?? process.env.MARSHALL_CONTROL_ADDRS ?? "") === ""
    && (controlNetworkPath == null || controlNetworkPath === "")
    && (controlNetworkUrl == null || controlNetworkUrl === "")
  ) {
    throw new Error("--control, --control-addrs, or --control-network-url/path is required when auto-caching from a model registry");
  }

  const registry = await loadModelRegistrySource({ registryPath, registryUrl });
  const selected = selectModelRegistryEntry(registry, {
    packageJobId: args["model-package-id"] ?? args["package-job-id"] ?? process.env.MARSHALL_MODEL_PACKAGE_ID ?? process.env.MARSHALL_PACKAGE_JOB_ID,
    model: args.model ?? process.env.MARSHALL_MODEL,
    adapterId: args["adapter-id"] ?? process.env.MARSHALL_ADAPTER_ID,
    adapterArtifactHash: args["adapter-hash"] ?? process.env.MARSHALL_ADAPTER_HASH,
  });
  const controlAddrs = await resolveControlMultiaddrs({
    controlAddr,
    controlAddrs: args["control-addrs"] ?? process.env.MARSHALL_CONTROL_ADDRS,
    controlNetworkPath,
    controlNetworkUrl,
  });
  const promoter = await WorkerPeer.create({
    privateKeyPath,
    workerId: args["promoter-worker-id"] ?? process.env.MARSHALL_MODEL_PROMOTER_WORKER_ID ?? `${hostname()}-inference-model-cache`,
    controlAddr: controlAddrs[0],
    controlAddrs,
    listen: splitList(args["promoter-listen"] ?? process.env.MARSHALL_MODEL_PROMOTER_LISTEN ?? "/ip4/0.0.0.0/tcp/0"),
    backend: "cpu",
    supportedJobs: ["benchmark_inference"],
    memoryGb: positiveNumberArg(args["promoter-memory-gb"] ?? process.env.MARSHALL_MODEL_PROMOTER_MEMORY_GB ?? "1"),
    tokensPerSecond: numberArg(args["promoter-tokens-per-second"] ?? process.env.MARSHALL_MODEL_PROMOTER_TOKENS_PER_SECOND ?? "0"),
    swarmToken: args["swarm-token"] ?? process.env.MARSHALL_SWARM_TOKEN,
  });

  try {
    const result = await promoteModelPackageFromControl({
      worker: promoter,
      packageJobId: selected.package_job_id,
      packageArtifactHash: selected.package_artifact_hash,
      outputRoot: args["model-cache-dir"] ?? args["output-root"] ?? process.env.MARSHALL_MODEL_CACHE_DIR ?? process.env.MARSHALL_MODEL_PROMOTION_DIR ?? ".marshall/model-cache",
      packageName: selected.package_job_id,
      adapterId: selected.adapter_id,
      adapterArtifactHash: selected.adapter_artifact_hash,
      chunkBytes: optionalPositiveIntegerArg(args["chunk-bytes"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_BYTES),
      maxChunkRetries: optionalPositiveIntegerArg(args["chunk-retries"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_RETRIES),
    });
    console.log(JSON.stringify({
      ...result,
      type: "marshall_inference_worker_model_cached",
      registry_updated_at: registry.updated_at,
      base_model: selected.base_model,
      peer_id: promoter.peerId,
      transfer: selected.transfer,
    }, null, 2));
    return result.model_package_path;
  } finally {
    await promoter.stop();
  }
}

function requiredArg(value: string | undefined, name: string): string {
  if (value == null || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function numberArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}

function positiveIntegerArg(value: string): number {
  const parsed = numberArg(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function positiveNumberArg(value: string): number {
  const parsed = numberArg(value);
  if (parsed <= 0) {
    throw new Error(`invalid positive number: ${value}`);
  }
  return parsed;
}

function optionalPositiveIntegerArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return positiveIntegerArg(value);
}

function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      cleanup()
        .catch((error) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        })
        .finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
