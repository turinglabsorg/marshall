import { createChatServer, defaultChatPublicDir, defaultChatRunnerPath } from "./chat-server.js";

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? process.env.MARSHALL_CHAT_HOST ?? "127.0.0.1";
const port = positiveIntegerArg(args.port ?? process.env.MARSHALL_CHAT_PORT ?? "8787");
const publicDir = args["public-dir"] ?? process.env.MARSHALL_CHAT_PUBLIC_DIR ?? defaultChatPublicDir();
const runnerPath = args.runner ?? process.env.MARSHALL_CHAT_RUNNER ?? defaultChatRunnerPath();
const pythonBin = args.python ?? process.env.MARSHALL_PYTHON ?? "python3";
const p2pWorkerAddr = args["p2p-worker-addr"] ?? process.env.MARSHALL_CHAT_P2P_WORKER_ADDR;
const p2pWorkerAddrs = optionalSplitList(args["p2p-worker-addrs"] ?? process.env.MARSHALL_CHAT_P2P_WORKER_ADDRS);
const server = await createChatServer({
  publicDir,
  runnerPath,
  pythonBin,
  runtime: runtimeArg(args.runtime ?? process.env.MARSHALL_CHAT_RUNTIME ?? "local_process"),
  p2pPrivateKeyPath: args["p2p-key"] ?? process.env.MARSHALL_CHAT_P2P_KEY,
  p2pListen: optionalSplitList(args["p2p-listen"] ?? process.env.MARSHALL_CHAT_P2P_LISTEN),
  p2pWorkerAddr,
  p2pWorkerAddrs,
  p2pRequestTimeoutMs: optionalPositiveIntegerArg(args["p2p-timeout-ms"] ?? process.env.MARSHALL_CHAT_P2P_TIMEOUT_MS),
  p2pProbeTimeoutMs: optionalPositiveIntegerArg(args["p2p-probe-timeout-ms"] ?? process.env.MARSHALL_CHAT_P2P_PROBE_TIMEOUT_MS),
  p2pMaxAttempts: optionalPositiveIntegerArg(args["p2p-max-attempts"] ?? process.env.MARSHALL_CHAT_P2P_MAX_ATTEMPTS),
  conversationDir: args["conversation-dir"] ?? process.env.MARSHALL_CHAT_CONVERSATION_DIR,
  conversationTtlDays: optionalPositiveNumberArg(args["conversation-ttl-days"] ?? process.env.MARSHALL_CHAT_CONVERSATION_TTL_DAYS),
  maxContextMessages: optionalPositiveIntegerArg(args["max-context-messages"] ?? process.env.MARSHALL_CHAT_MAX_CONTEXT_MESSAGES),
  maxMemoryItems: optionalPositiveIntegerArg(args["max-memory-items"] ?? process.env.MARSHALL_CHAT_MAX_MEMORY_ITEMS),
  modelPackagePath: args["model-package"] ?? args.package ?? process.env.MARSHALL_MODEL_PACKAGE,
  model: args.model ?? process.env.MARSHALL_MODEL,
  adapterPath: args["adapter-path"] ?? process.env.MARSHALL_ADAPTER_PATH,
  adapterArtifactHash: args["adapter-hash"] ?? process.env.MARSHALL_ADAPTER_HASH,
  adapterId: args["adapter-id"] ?? process.env.MARSHALL_ADAPTER_ID,
  systemPrompt: args["system-prompt"] ?? process.env.MARSHALL_CHAT_SYSTEM_PROMPT ?? "You are Marshall, a concise assistant running on a permissionless distributed training prototype.",
  maxTokens: positiveIntegerArg(args["max-tokens"] ?? process.env.MARSHALL_CHAT_MAX_TOKENS ?? "160"),
  temperature: numberArg(args.temperature ?? process.env.MARSHALL_CHAT_TEMPERATURE ?? "0.2"),
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    type: "marshall_chat_server_started",
    url: `http://${host}:${port}`,
    host,
    port,
    runtime: args.runtime ?? process.env.MARSHALL_CHAT_RUNTIME ?? "local_process",
    public_dir: publicDir,
    runner: runnerPath,
    conversation_dir: args["conversation-dir"] ?? process.env.MARSHALL_CHAT_CONVERSATION_DIR ?? null,
    p2p_worker_addrs: countWorkerAddrs(p2pWorkerAddr, p2pWorkerAddrs),
  }, null, 2));
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

function optionalSplitList(value: string | undefined): string[] | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return splitList(value);
}

function countWorkerAddrs(single: string | undefined, values: string[] | undefined): number {
  return new Set([
    ...splitList(single ?? ""),
    ...(values ?? []),
  ]).size;
}

function runtimeArg(value: string) {
  if (value === "local_process" || value === "p2p_worker") {
    return value;
  }
  throw new Error(`unsupported chat runtime: ${value}`);
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

function optionalPositiveIntegerArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return positiveIntegerArg(value);
}

function optionalPositiveNumberArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = numberArg(value);
  if (parsed <= 0) {
    throw new Error(`invalid positive number: ${value}`);
  }
  return parsed;
}
