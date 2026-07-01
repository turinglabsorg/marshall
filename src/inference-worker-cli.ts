import { InferenceWorkerPeer } from "./inference-worker.js";

const args = parseArgs(process.argv.slice(2));
const worker = await InferenceWorkerPeer.create({
  privateKeyPath: requiredArg(args.key ?? process.env.MARSHALL_INFERENCE_KEY, "--key"),
  listen: splitList(args.listen ?? process.env.MARSHALL_INFERENCE_LISTEN ?? "/ip4/0.0.0.0/tcp/8788"),
  workerId: args["worker-id"] ?? process.env.MARSHALL_INFERENCE_WORKER_ID,
  publicDir: args["public-dir"] ?? process.env.MARSHALL_CHAT_PUBLIC_DIR,
  runnerPath: args.runner ?? process.env.MARSHALL_CHAT_RUNNER,
  pythonBin: args.python ?? process.env.MARSHALL_PYTHON ?? "python3",
  modelPackagePath: args["model-package"] ?? args.package ?? process.env.MARSHALL_MODEL_PACKAGE,
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
