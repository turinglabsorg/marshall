import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Libp2p } from "@libp2p/interface";
import {
  defaultConversationDir,
  FileConversationStore,
  publicConversation,
  ttlDaysToMs,
  type LongTermMemoryUpdate,
} from "./chat-memory.js";
import { InferenceRouter } from "./inference-router.js";
import { createMarshallNode } from "./node.js";
import { InferenceStreamEventSchema, type InferenceRequest, type InferenceStreamEvent } from "./schemas.js";

export type ChatRuntime = "local_process" | "p2p_worker";

export interface ChatServerConfig {
  publicDir: string;
  runnerPath: string;
  pythonBin: string;
  runtime?: ChatRuntime;
  p2pPrivateKeyPath?: string;
  p2pListen?: string[];
  p2pWorkerAddr?: string;
  p2pWorkerAddrs?: string[];
  p2pRequestTimeoutMs?: number;
  p2pProbeTimeoutMs?: number;
  p2pMaxAttempts?: number;
  conversationDir?: string;
  conversationTtlDays?: number;
  maxContextMessages?: number;
  maxMemoryItems?: number;
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
  p2pWorkerAddrs: string[];
}

interface RuntimeChatServerConfig extends ResolvedChatServerConfig {
  conversations: FileConversationStore;
  inferenceRouter?: InferenceRouter;
}

interface ChatRequest {
  conversation_id?: unknown;
  prompt?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
}

interface ConversationMemoryRequest {
  conversation_id?: unknown;
  memory?: unknown;
  summary?: unknown;
  facts?: unknown;
  preferences?: unknown;
  goals?: unknown;
  open_tasks?: unknown;
  plans?: unknown;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface InferenceResult {
  type: string;
  model: string;
  adapter_path: string | null;
  adapter_id?: string;
  adapter_hash?: string;
  peer_id?: string;
  worker_id?: string;
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
  const p2pWorkerAddrs = normalizeWorkerAddrs(config);

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
  if (runtime === "p2p_worker" && p2pWorkerAddrs.length === 0) {
    throw new Error("--p2p-worker-addr or --p2p-worker-addrs is required for p2p_worker runtime");
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
    p2pWorkerAddrs,
  };
}

export async function createChatServer(config: ChatServerConfig): Promise<Server> {
  const resolved = await resolveChatConfig(config);
  const conversations = new FileConversationStore({
    dir: resolved.conversationDir ?? defaultConversationDir(),
    ttlMs: resolved.conversationTtlDays == null ? undefined : ttlDaysToMs(resolved.conversationTtlDays),
  });
  const p2pNode = resolved.runtime === "p2p_worker"
    ? await createMarshallNode({
      privateKeyPath: resolved.p2pPrivateKeyPath!,
      listen: resolved.p2pListen ?? ["/ip4/127.0.0.1/tcp/0"],
    })
    : undefined;
  const inferenceRouter = p2pNode == null ? undefined : new InferenceRouter({
    node: p2pNode,
    workerAddrs: resolved.p2pWorkerAddrs,
    model: resolved.model,
    adapterId: resolved.adapterId,
    adapterHash: resolved.adapterArtifactHash,
    requestTimeoutMs: resolved.p2pRequestTimeoutMs,
    probeTimeoutMs: resolved.p2pProbeTimeoutMs,
    maxAttempts: resolved.p2pMaxAttempts,
  });
  const runtimeConfig: RuntimeChatServerConfig = {
    ...resolved,
    p2pNode,
    conversations,
    inferenceRouter,
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

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: RuntimeChatServerConfig): Promise<void> {
  const url = new URL(request.url ?? "/", "http://marshall.chat");
  if (request.method === "GET" && url.pathname === "/api/health") {
    await handleHealth(response, config);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/conversation") {
    await handleConversation(url, response, config);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/conversation/memory") {
    await handleConversationMemory(request, response, config);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/inference/workers") {
    await handleInferenceWorkers(url, response, config);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    await handleChat(request, response, config);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat/stream") {
    await handleChatStream(request, response, config);
    return;
  }
  if (request.method === "GET") {
    await serveStatic(response, config.publicDir, url.pathname);
    return;
  }
  sendJson(response, 405, { type: "marshall_chat_method_not_allowed" });
}

async function handleHealth(response: ServerResponse, config: RuntimeChatServerConfig): Promise<void> {
  const adapterStat = config.runtime === "local_process" && config.adapterPath != null
    ? await stat(config.adapterPath).catch(() => null)
    : null;
  const workers = config.inferenceRouter == null ? [] : await config.inferenceRouter.refresh();
  sendJson(response, 200, {
    type: "marshall_chat_health",
    ready: config.runtime === "local_process" ? adapterStat != null : (config.inferenceRouter?.readyWorkers ?? 0) > 0,
    runtime: config.runtime,
    model: config.model,
    adapter_id: config.adapterId,
    adapter_path: config.adapterPath ?? null,
    adapter_hash: config.adapterArtifactHash,
    p2p_gateway_peer_id: config.p2pNode?.peerId.toString() ?? null,
    inference: {
      configured_workers: config.inferenceRouter?.configuredWorkers ?? 0,
      ready_workers: config.inferenceRouter?.readyWorkers ?? 0,
      workers,
    },
    memory: {
      backend: "file",
      conversation_dir: config.conversationDir ?? defaultConversationDir(),
      max_context_messages: config.maxContextMessages ?? 18,
      max_memory_items: config.maxMemoryItems ?? 24,
      ttl_days: config.conversationTtlDays ?? null,
    },
    package_path: config.modelPackagePath ?? null,
    eval: config.packageInfo?.eval ?? null,
  });
}

async function handleInferenceWorkers(url: URL, response: ServerResponse, config: RuntimeChatServerConfig): Promise<void> {
  if (config.inferenceRouter == null) {
    sendJson(response, 400, {
      type: "marshall_chat_inference_workers",
      error: "p2p inference router is not enabled",
    });
    return;
  }
  const force = url.searchParams.get("refresh") !== "false";
  sendJson(response, 200, {
    type: "marshall_chat_inference_workers",
    workers: await config.inferenceRouter.refresh({ force }),
  });
}

async function handleConversation(url: URL, response: ServerResponse, config: RuntimeChatServerConfig): Promise<void> {
  const conversationId = url.searchParams.get("conversation_id");
  if (conversationId == null || conversationId === "") {
    sendJson(response, 400, { type: "marshall_chat_conversation_error", error: "conversation_id is required" });
    return;
  }
  const conversation = await config.conversations.get(conversationId);
  if (conversation == null) {
    sendJson(response, 404, { type: "marshall_chat_conversation_not_found" });
    return;
  }
  sendJson(response, 200, {
    type: "marshall_chat_conversation",
    conversation: publicConversation(conversation),
  });
}

async function handleConversationMemory(request: IncomingMessage, response: ServerResponse, config: RuntimeChatServerConfig): Promise<void> {
  const body = await readJsonBody<ConversationMemoryRequest>(request);
  const id = requiredConversationId(body.conversation_id);
  const memory = parseMemoryUpdate(body);
  const conversation = await config.conversations.updateMemory(id, memory, conversationMetadata(config));
  sendJson(response, 200, {
    type: "marshall_chat_conversation_memory",
    conversation: publicConversation(conversation),
  });
}

async function handleChat(request: IncomingMessage, response: ServerResponse, config: RuntimeChatServerConfig): Promise<void> {
  const body = await readJsonBody<ChatRequest>(request);
  const userContent = userPrompt(body);
  const context = await config.conversations.context(
    conversationId(body),
    userContent,
    conversationMetadata(config),
    { maxMessages: config.maxContextMessages, maxMemoryItems: config.maxMemoryItems },
  );
  const maxTokens = positiveInteger(body.max_tokens, config.maxTokens, "max_tokens");
  const temperature = finiteNumber(body.temperature, config.temperature, "temperature");
  const promptSystem = systemPrompt(body, config.systemPrompt);
  const result = config.runtime === "p2p_worker"
    ? await runP2pInference(config, context.prompt, promptSystem, maxTokens, temperature)
    : await runLocalInference(config, context.prompt, promptSystem, maxTokens, temperature);
  const updatedConversation = await config.conversations.appendTurn(
    context.conversation,
    userContent,
    result.text ?? result.raw_text ?? "",
    conversationMetadata(config),
  );
  sendJson(response, 200, {
    type: "marshall_chat_response",
    runtime: config.runtime,
    model: result.model ?? config.model,
    adapter_id: result.adapter_id ?? config.adapterId,
    adapter_hash: result.adapter_hash ?? config.adapterArtifactHash,
    worker_id: result.worker_id ?? null,
    worker_peer_id: result.peer_id ?? null,
    conversation_id: updatedConversation.conversation_id,
    prompt: userContent,
    text: result.text ?? "",
    raw_text: result.raw_text ?? "",
    elapsed_ms: result.elapsed_ms ?? 0,
    conversation: publicConversation(updatedConversation),
  });
}

async function handleChatStream(request: IncomingMessage, response: ServerResponse, config: RuntimeChatServerConfig): Promise<void> {
  writeSseHead(response);
  try {
    const body = await readJsonBody<ChatRequest>(request);
    const userContent = userPrompt(body);
    const context = await config.conversations.context(
      conversationId(body),
      userContent,
      conversationMetadata(config),
      { maxMessages: config.maxContextMessages, maxMemoryItems: config.maxMemoryItems },
    );
    const maxTokens = positiveInteger(body.max_tokens, config.maxTokens, "max_tokens");
    const temperature = finiteNumber(body.temperature, config.temperature, "temperature");
    const promptSystem = systemPrompt(body, config.systemPrompt);
    sendSse(response, "accepted", {
      conversation_id: context.conversation.conversation_id,
      model: config.model,
      adapter_id: config.adapterId,
      adapter_hash: config.adapterArtifactHash,
    });
    const result = config.runtime === "p2p_worker"
      ? await runP2pInferenceStream(config, context.prompt, promptSystem, maxTokens, temperature, (event) => sendInferenceSse(response, event, config))
      : await runLocalInferenceStream(config, context.prompt, promptSystem, maxTokens, temperature, (event) => sendInferenceSse(response, event, config));
    const updatedConversation = await config.conversations.appendTurn(
      context.conversation,
      userContent,
      result.text ?? result.raw_text ?? "",
      conversationMetadata(config),
    );
    sendSse(response, "done", {
      type: "marshall_chat_response",
      runtime: config.runtime,
      model: result.model ?? config.model,
      adapter_id: result.adapter_id ?? config.adapterId,
      adapter_hash: result.adapter_hash ?? config.adapterArtifactHash,
      worker_id: result.worker_id ?? null,
      worker_peer_id: result.peer_id ?? null,
      conversation_id: updatedConversation.conversation_id,
      prompt: userContent,
      text: result.text ?? "",
      raw_text: result.raw_text ?? "",
      elapsed_ms: result.elapsed_ms ?? 0,
      conversation: publicConversation(updatedConversation),
    });
  } catch (error) {
    sendSse(response, "error", {
      type: "marshall_chat_stream_error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    response.end();
  }
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

async function runLocalInferenceStream(
  config: ResolvedChatServerConfig,
  prompt: string,
  promptSystem: string,
  maxTokens: number,
  temperature: number,
  onEvent: (event: InferenceStreamEvent) => void,
) {
  if (config.adapterPath == null || config.adapterPath === "") {
    throw new Error("local_process runtime requires adapterPath");
  }
  const result = await runInferenceStream({
    runnerPath: config.runnerPath,
    pythonBin: config.pythonBin,
    model: config.model,
    adapterPath: config.adapterPath,
    systemPrompt: promptSystem,
    prompt,
    maxTokens,
    temperature,
    onEvent,
  });
  return {
    ...result,
    adapter_id: config.adapterId,
    adapter_hash: config.adapterArtifactHash,
  };
}

async function runP2pInference(
  config: RuntimeChatServerConfig,
  prompt: string,
  promptSystem: string,
  maxTokens: number,
  temperature: number,
) {
  if (config.inferenceRouter == null) {
    throw new Error("p2p_worker runtime requires an active inference router");
  }
  const request: InferenceRequest = {
    type: "marshall_inference_request",
    prompt,
    system_prompt: promptSystem,
    max_tokens: maxTokens,
    temperature,
  };
  return config.inferenceRouter.generate(request);
}

async function runP2pInferenceStream(
  config: RuntimeChatServerConfig,
  prompt: string,
  promptSystem: string,
  maxTokens: number,
  temperature: number,
  onEvent: (event: InferenceStreamEvent) => void,
) {
  if (config.inferenceRouter == null) {
    throw new Error("p2p_worker runtime requires an active inference router");
  }
  const request: InferenceRequest = {
    type: "marshall_inference_request",
    prompt,
    system_prompt: promptSystem,
    max_tokens: maxTokens,
    temperature,
  };
  try {
    return await config.inferenceRouter.generateStream(request, onEvent);
  } catch {
    onEvent({
      type: "marshall_inference_stream_event",
      event: "started",
      model: config.model,
      adapter_id: config.adapterId,
      adapter_hash: config.adapterArtifactHash,
    });
    const response = await config.inferenceRouter.generate(request);
    onEvent({
      type: "marshall_inference_stream_event",
      event: "completed",
      peer_id: response.peer_id,
      worker_id: response.worker_id,
      model: response.model ?? config.model,
      adapter_id: response.adapter_id ?? config.adapterId,
      adapter_hash: response.adapter_hash ?? config.adapterArtifactHash,
      prompt: response.prompt ?? prompt,
      text: response.text ?? response.raw_text ?? "",
      raw_text: response.raw_text ?? response.text ?? "",
      elapsed_ms: response.elapsed_ms ?? 0,
    });
    return response;
  }
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

export async function runInferenceStream(options: {
  runnerPath: string;
  pythonBin: string;
  model: string;
  adapterPath: string;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  onEvent: (event: InferenceStreamEvent) => void;
}): Promise<InferenceResult> {
  const stdout = await runProcessStreaming(options.pythonBin, [
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
    "--stream-jsonl",
  ], options.onEvent);
  if (stdout == null) {
    throw new Error("streaming inference completed without final event");
  }
  return stdout;
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

function userPrompt(body: ChatRequest): string {
  if (typeof body.prompt === "string" && body.prompt.trim() !== "") {
    return body.prompt.trim();
  }
  if (Array.isArray(body.messages)) {
    const messages = parseMessages(body.messages);
    const lastUser = messages.filter((message) => message.role === "user").at(-1);
    if (lastUser != null) {
      return lastUser.content;
    }
  }
  throw new Error("prompt or messages with a user message is required");
}

function conversationId(body: ChatRequest): string | undefined {
  if (body.conversation_id == null || body.conversation_id === "") {
    return undefined;
  }
  return stringValue(body.conversation_id, "conversation_id");
}

function requiredConversationId(value: unknown): string {
  if (value == null || value === "") {
    throw new Error("conversation_id is required");
  }
  return stringValue(value, "conversation_id");
}

function parseMemoryUpdate(body: ConversationMemoryRequest): LongTermMemoryUpdate {
  const source = typeof body.memory === "object" && body.memory != null
    ? body.memory as Record<string, unknown>
    : body as Record<string, unknown>;
  const update: LongTermMemoryUpdate = {};
  if ("summary" in source) {
    update.summary = stringOrEmpty(source.summary, "summary");
  }
  for (const section of ["facts", "preferences", "goals", "open_tasks", "plans"] as const) {
    if (section in source) {
      update[section] = memorySection(source[section], section);
    }
  }
  return update;
}

function memorySection(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function stringOrEmpty(value: unknown, field: string): string {
  if (value == null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function conversationMetadata(config: ResolvedChatServerConfig) {
  return {
    model: config.model,
    adapterId: config.adapterId,
    adapterHash: config.adapterArtifactHash,
  };
}

function normalizeWorkerAddrs(config: ChatServerConfig): string[] {
  const values = [
    config.p2pWorkerAddr,
    ...(config.p2pWorkerAddrs ?? []),
  ];
  return Array.from(new Set(values.flatMap((value) => splitOptionalList(value))));
}

function splitOptionalList(value: string | undefined): string[] {
  if (value == null || value === "") {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function systemPrompt(body: ChatRequest, fallback: string): string {
  if (!Array.isArray(body.messages)) {
    return fallback;
  }
  const messages = parseMessages(body.messages);
  return messages.find((message) => message.role === "system")?.content ?? fallback;
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

function runProcessStreaming(
  command: string,
  values: string[],
  onEvent: (event: InferenceStreamEvent) => void,
): Promise<InferenceResult | null> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, values, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let completed: InferenceResult | null = null;
    let streamError: string | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== "") {
          const event = InferenceStreamEventSchema.parse(JSON.parse(line));
          onEvent(event);
          if (event.event === "completed") {
            completed = {
              type: "marshall_chat_completion",
              model: event.model ?? "",
              adapter_path: null,
              peer_id: event.peer_id,
              worker_id: event.worker_id,
              prompt: event.prompt ?? "",
              text: event.text,
              raw_text: event.raw_text,
              elapsed_ms: event.elapsed_ms,
            };
          }
          if (event.event === "error") {
            streamError = event.error;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      try {
        const tail = buffer.trim();
        if (tail !== "") {
          const event = InferenceStreamEventSchema.parse(JSON.parse(tail));
          onEvent(event);
          if (event.event === "completed") {
            completed = {
              type: "marshall_chat_completion",
              model: event.model ?? "",
              adapter_path: null,
              peer_id: event.peer_id,
              worker_id: event.worker_id,
              prompt: event.prompt ?? "",
              text: event.text,
              raw_text: event.raw_text,
              elapsed_ms: event.elapsed_ms,
            };
          }
          if (event.event === "error") {
            streamError = event.error;
          }
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (exitCode === 0) {
        resolveProcess(completed);
        return;
      }
      reject(new Error(streamError ?? (stderr.trim() || stdout.trim() || `inference process exited ${exitCode ?? "unknown"}`)));
    });
  });
}

function writeSseHead(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
}

function sendInferenceSse(response: ServerResponse, event: InferenceStreamEvent, config: ResolvedChatServerConfig): void {
  const publicEvent: Record<string, unknown> = { ...event };
  delete publicEvent.prompt;
  sendSse(response, event.event, {
    ...publicEvent,
    model: event.event === "started" || event.event === "completed" ? event.model ?? config.model : undefined,
    adapter_id: event.event === "started" || event.event === "completed" ? event.adapter_id ?? config.adapterId : undefined,
    adapter_hash: event.event === "started" || event.event === "completed" ? event.adapter_hash ?? config.adapterArtifactHash : undefined,
  });
}

function sendSse(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
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
