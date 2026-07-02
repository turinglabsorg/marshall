import { hostname } from "node:os";
import { resolveControlMultiaddrs } from "./control-network.js";
import { promoteModelPackageFromControl } from "./model-promotion.js";
import { WorkerPeer } from "./worker-peer.js";

const args = parseArgs(process.argv.slice(2));
const packageJobId = requiredArg("package-job-id", args["package-job-id"] ?? process.env.MARSHALL_PACKAGE_JOB_ID);
const packageArtifactHash = requiredArg("package-hash", args["package-hash"] ?? process.env.MARSHALL_PACKAGE_HASH);
const outputRoot = args["output-root"] ?? process.env.MARSHALL_MODEL_PROMOTION_DIR ?? ".marshall/model-promotions";
const workerId = args["worker-id"] ?? process.env.MARSHALL_WORKER_ID ?? `${hostname()}-model-promoter`;
const controlAddrs = await resolveControlMultiaddrs({
  controlAddr: args.control ?? process.env.MARSHALL_CONTROL_ADDR,
  controlAddrs: args["control-addrs"] ?? process.env.MARSHALL_CONTROL_ADDRS,
  controlNetworkPath: args["control-network-path"] ?? process.env.MARSHALL_CONTROL_NETWORK_PATH,
  controlNetworkUrl: args["control-network-url"] ?? process.env.MARSHALL_CONTROL_NETWORK_URL,
});
const worker = await WorkerPeer.create({
  privateKeyPath: args.key ?? process.env.MARSHALL_WORKER_KEY ?? ".marshall/model-promoter.key",
  workerId,
  controlAddr: controlAddrs[0],
  controlAddrs,
  listen: splitList(args.listen ?? process.env.MARSHALL_WORKER_LISTEN ?? "/ip4/0.0.0.0/tcp/0"),
  backend: "cpu",
  supportedJobs: ["benchmark_inference"],
  memoryGb: positiveNumberArg(args["memory-gb"] ?? process.env.MARSHALL_MEMORY_GB ?? "1"),
  tokensPerSecond: numberArg(args["tokens-per-second"] ?? process.env.MARSHALL_TOKENS_PER_SECOND ?? "0"),
  swarmToken: args["swarm-token"] ?? process.env.MARSHALL_SWARM_TOKEN,
});

try {
  const result = await promoteModelPackageFromControl({
    worker,
    packageJobId,
    packageArtifactHash,
    outputRoot,
    packageName: args.name ?? args["package-name"] ?? process.env.MARSHALL_MODEL_PROMOTION_NAME,
    adapterId: args["adapter-id"] ?? process.env.MARSHALL_ADAPTER_ID,
    adapterArtifactHash: args["adapter-hash"] ?? process.env.MARSHALL_ADAPTER_HASH,
    chunkBytes: optionalPositiveIntegerArg(args["chunk-bytes"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_BYTES),
    maxChunkRetries: optionalPositiveIntegerArg(args["chunk-retries"] ?? process.env.MARSHALL_ARTIFACT_CHUNK_RETRIES),
  });
  console.log(JSON.stringify({
    ...result,
    peer_id: worker.peerId,
    worker_id: workerId,
    transfer: {
      protocol: "/marshall/artifact/fetch/1.0.0",
      chunked: true,
      hash_verified: true,
      https_payload: false,
    },
  }, null, 2));
} finally {
  await worker.stop();
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

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function requiredArg(name: string, value: string | undefined): string {
  if (value == null || value.trim() === "") {
    throw new Error(`--${name} is required`);
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

function positiveNumberArg(value: string): number {
  const parsed = numberArg(value);
  if (parsed <= 0) {
    throw new Error(`invalid positive number: ${value}`);
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

function optionalPositiveIntegerArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return positiveIntegerArg(value);
}
