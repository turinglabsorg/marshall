import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Libp2p } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { createMarshallNode } from "./node.js";
import { PROTOCOLS } from "./protocols.js";
import { InferenceResponseSchema } from "./schemas.js";
import { requestJson } from "./wire.js";

export type ChatRuntime = "local_process" | "p2p_worker";

export interface ChatServerConfig {
  publicDir: string;
  runnerPath: string;
  pythonBin: string;
  runtime?: ChatRuntime;
  p2pPrivateKeyPath?: string;
  p2pListen?: string[];
  p2pWorkerAddr?: string;
  p2pRequestTimeoutMs?: number;
  modelPackagePath?: string;
  model?: string;
  adapterPath?: string;
  adapterArtifactHash?: string;
  adapterId?: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

export interface LoadedModelPackage {
  base_model: string;
  adapter_id: string;
  adapter_path: string;
  adapter_artifact_hash: string;
  eval?: {
    accuracy?: number;
    score?: number;
    examples?: number;
    correct?: number;
  };
}

export interface ResolvedChatServerConfig extends ChatServerConfig {
  runtime: ChatRuntime;
  model: string;
  adapterPath?: string;
  adapterArtifactHash: string;
  adapterId: string;
  packageInfo: LoadedModelPackage | null;
  p2pNode?: Libp2p;
}

interface ChatRequest {
  prompt?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface InferenceResult {
  type: string;
  model: string;
  adapter_path: string | null;
  prompt: string;
  text: string;
  raw_text: string;
  elapsed_ms: number;
}

export async function resolveChatConfig(config: ChatServerConfig): Promise<ResolvedChatServerConfig> {
  const packageInfo = config.modelPackagePath == null ? null : await loadModelPackage(config.modelPackagePath);
  const runtime = config.runtime ?? "local_process";
  const model = config.model ?? packageInfo?.base_model;
  const adapterPath = config.adapterPath ?? packageInfo?.adapter_path;
  const adapterArtifactHash = config.adapterArtifactHash ?? packageInfo?.adapter_artifact_hash;
  const adapterId = config.adapterId ?? packageInfo?.adapter_id;

  if (model == null || model === "") {
    throw new Error("--model or model_package.base_model is required");
  }
  if (runtime === "local_process" && (adapterPath == null || adapterPath === "")) {
    throw new Error("--adapter-path or model_package.adapter_path is required");
  }
  if (adapterArtifactHash == null || adapterArtifactHash === "") {
    throw new Error("--adapter-hash or model_package.adapter_artifact_hash is required");
  }
  if (adapterId == null || adapterId === "") {
    throw new Error("--adapter-id or model_package.adapter_id is required");
  }
  if (runtime === "p2p_worker" && (config.p2pWorkerAddr == null || config.p2pWorkerAddr === "")) {
    throw new Error("--p2p-worker-addr is required for p2p_worker runtime");
  }
  if (runtime === "p2p_worker" && (config.p2pPrivateKeyPath == null || config.p2pPrivateKeyPath === "")) {
    throw new Error("--p2p-key is required for p2p_worker runtime");
  }

  return {
    ...config,
    runtime,
    model,
    adapterPath,
    adapterArtifactHash,
    adapterId,
    packageInfo,
  };
}

export async function createChatServer(config: ChatServerConfig): Promise<Server> {
  const resolved = await resolveChatConfig(config);
  const p2pNode = resolved.runtime === "p2p_worker"
    ? await createMarshallNode({
      privateKeyPath: resolved.p2pPrivateKeyPath!,
      listen: resolved.p2pListen ?? ["/ip4/127.0.0.1/tcp/0"],
    })
    : undefined;
  const runtimeConfig: ResolvedChatServerConfig = {
    ...resolved,
    p2pNode,
  };
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, runtimeConfig);
    } catch (error) {
      sendJson(response, 500, {
        type: "marshall_chat_server_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.on("close", () => {
    void p2pNode?.stop();
  });
  return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: ResolvedChatServerConfig): Promise<void> {
  const url = new URL(request.url ?? "/", "http://marshall.chat");
  if (request.method === "GET" && url.pathname === "/api/health") {
    await handleHealth(response, config);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    await handleChat(request, response, config);
    return;
  }
  if (request.method === "GET") {
    await serveStatic(response, config.publicDir, url.pathname);
    return;
  }
  sendJson(response, 405, { type: "marshall_chat_method_not_allowed" });
}

async function handleHealth(response: ServerResponse, config: ResolvedChatServerConfig): Promise<void> {
  const adapterStat = config.runtime === "local_process" && config.adapterPath != null
    ? await stat(config.adapterPath).catch(() => null)
    : null;
  sendJson(response, 200, {
    type: "marshall_chat_health",
    ready: config.runtime === "local_process" ? adapterStat != null : config.p2pNode != null,
    runtime: config.runtime,
    model: config.model,
    adapter_id: config.adapterId,
    adapter_path: config.adapterPath ?? null,
    adapter_hash: config.adapterArtifactHash,
    p2p_worker_addr: config.p2pWorkerAddr ?? null,
    p2p_gateway_peer_id: config.p2pNode?.peerId.toString() ?? null,
    package_path: config.modelPackagePath ?? null,
    eval: config.packageInfo?.eval ?? null,
  });
}

async function handleChat(request: IncomingMessage, response: ServerResponse, config: ResolvedChatServerConfig): Promise<void> {
  const body = await readJsonBody<ChatRequest>(request);
  const prompt = chatPrompt(body);
  const maxTokens = positiveInteger(body.max_tokens, config.maxTokens, "max_tokens");
  const temperature = finiteNumber(body.temperature, config.temperature, "temperature");
  const promptSystem = systemPrompt(body, config.systemPrompt);
  const result = config.runtime === "p2p_worker"
    ? await runP2pInference(config, prompt, promptSystem, maxTokens, temperature)
    : await runLocalInference(config, prompt, promptSystem, maxTokens, temperature);
  sendJson(response, 200, {
    type: "marshall_chat_response",
    runtime: config.runtime,
    model: result.model ?? config.model,
    adapter_id: result.adapter_id ?? config.adapterId,
    adapter_hash: result.adapter_hash ?? config.adapterArtifactHash,
    prompt,
    text: result.text ?? "",
    raw_text: result.raw_text ?? "",
    elapsed_ms: result.elapsed_ms ?? 0,
  });
}

async function runLocalInference(
  config: ResolvedChatServerConfig,
  prompt: string,
  promptSystem: string,
  maxTokens: number,
  temperature: number,
) {
  if (config.adapterPath == null || config.adapterPath === "") {
    throw new Error("local_process runtime requires adapterPath");
  }
  const result = await runInference({
    runnerPath: config.runnerPath,
    pythonBin: config.pythonBin,
    model: config.model,
    adapterPath: config.adapterPath,
    systemPrompt: promptSystem,
    prompt,
    maxTokens,
    temperature,
  });
  return {
    ...result,
    adapter_id: config.adapterId,
    adapter_hash: config.adapterArtifactHash,
  };
}

async function runP2pInference(
  config: ResolvedChatServerConfig,
  prompt: string,
  promptSystem: string,
  maxTokens: number,
  temperature: number,
) {
  if (config.p2pNode == null || config.p2pWorkerAddr == null) {
    throw new Error("p2p_worker runtime requires an active libp2p gateway node and worker address");
  }
  const response = InferenceResponseSchema.parse(await requestJson(
    config.p2pNode,
    multiaddr(config.p2pWorkerAddr),
    PROTOCOLS.inferenceGenerate,
    {
      type: "marshall_inference_request",
      prompt,
      system_prompt: promptSystem,
      max_tokens: maxTokens,
      temperature,
    },
    { timeoutMs: config.p2pRequestTimeoutMs ?? 120_000 },
  ));
  if (!response.accepted) {
    throw new Error(response.error ?? "p2p inference worker rejected request");
  }
  return response;
}

export async function runInference(options: {
  runnerPath: string;
  pythonBin: string;
  model: string;
  adapterPath: string;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
}): Promise<InferenceResult> {
  const stdout = await runProcess(options.pythonBin, [
    options.runnerPath,
    "--model",
    options.model,
    "--adapter-path",
    options.adapterPath,
    "--system-prompt",
    options.systemPrompt,
    "--prompt",
    options.prompt,
    "--max-tokens",
    String(options.maxTokens),
    "--temp",
    String(options.temperature),
  ]);
  const parsed = JSON.parse(stdout) as InferenceResult | { error?: string };
  if ("error" in parsed && parsed.error != null) {
    throw new Error(parsed.error);
  }
  return parsed as InferenceResult;
}

export async function loadModelPackage(path: string): Promise<LoadedModelPackage> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const evalRecord = typeof value.eval === "object" && value.eval != null ? value.eval as Record<string, unknown> : {};
  return {
    base_model: stringValue(value.base_model, "base_model"),
    adapter_id: stringValue(value.adapter_id, "adapter_id"),
    adapter_path: stringValue(value.adapter_path, "adapter_path"),
    adapter_artifact_hash: stringValue(value.adapter_artifact_hash, "adapter_artifact_hash"),
    eval: {
      accuracy: optionalNumber(evalRecord.accuracy),
      score: optionalNumber(evalRecord.score),
      examples: optionalNumber(evalRecord.examples),
      correct: optionalNumber(evalRecord.correct),
    },
  };
}

async function serveStatic(response: ServerResponse, publicDir: string, requestPath: string): Promise<void> {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  if (relativePath.includes("..")) {
    sendJson(response, 400, { type: "marshall_chat_bad_path" });
    return;
  }
  const filePath = resolve(publicDir, relativePath);
  if (!filePath.startsWith(resolve(publicDir))) {
    sendJson(response, 400, { type: "marshall_chat_bad_path" });
    return;
  }
  const fileStat = await stat(filePath).catch(() => null);
  if (fileStat == null || !fileStat.isFile()) {
    sendJson(response, 404, { type: "marshall_chat_not_found" });
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": "no-store",
  });
  await new Promise<void>((resolveStream, reject) => {
    createReadStream(filePath)
      .on("error", reject)
      .on("end", resolveStream)
      .pipe(response);
  });
}

function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}") as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function chatPrompt(body: ChatRequest): string {
  if (typeof body.prompt === "string" && body.prompt.trim() !== "") {
    return body.prompt.trim();
  }
  if (Array.isArray(body.messages)) {
    const messages = parseMessages(body.messages);
    const lastUser = messages.filter((message) => message.role === "user").at(-1);
    if (lastUser != null) {
      return transcriptPrompt(messages, lastUser.content);
    }
  }
  throw new Error("prompt or messages with a user message is required");
}

function systemPrompt(body: ChatRequest, fallback: string): string {
  if (!Array.isArray(body.messages)) {
    return fallback;
  }
  const messages = parseMessages(body.messages);
  return messages.find((message) => message.role === "system")?.content ?? fallback;
}

function transcriptPrompt(messages: ChatMessage[], lastUserContent: string): string {
  const history = messages
    .filter((message) => message.role !== "system")
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return history === "" ? lastUserContent : `${history}\nassistant:`;
}

function parseMessages(value: unknown[]): ChatMessage[] {
  return value.map((item) => {
    if (typeof item !== "object" || item == null) {
      throw new Error("messages must contain objects");
    }
    const record = item as Record<string, unknown>;
    const role = record.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new Error("message role must be system, user, or assistant");
    }
    return {
      role,
      content: stringValue(record.content, "message.content"),
    };
  });
}

function runProcess(command: string, values: string[]): Promise<string> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, values, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolveProcess(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `inference process exited ${exitCode ?? "unknown"}`));
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value, null, 2));
}

function contentType(path: string): string {
  const extension = extname(path);
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value == null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function finiteNumber(value: unknown, fallback: number, field: string): number {
  if (value == null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be finite`);
  }
  return parsed;
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function defaultChatPublicDir(): string {
  return resolve(process.cwd(), "chat/public");
}

export function defaultChatRunnerPath(): string {
  return resolve(process.cwd(), "training/mlx_lora_chat.py");
}
