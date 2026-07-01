import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ConversationRole = "system" | "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  created_at: string;
}

export interface ConversationRecord {
  type: "marshall_chat_conversation";
  conversation_id: string;
  created_at: string;
  updated_at: string;
  model: string;
  adapter_id: string;
  adapter_hash: string;
  summary: string;
  messages: ConversationMessage[];
}

export interface ConversationStoreOptions {
  dir: string;
  ttlMs?: number;
}

export interface ConversationMetadata {
  model: string;
  adapterId: string;
  adapterHash: string;
}

export interface ConversationContext {
  conversation: ConversationRecord;
  prompt: string;
  context_messages: ConversationMessage[];
}

const DEFAULT_CONTEXT_MESSAGES = 18;
const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,96}$/;

export class FileConversationStore {
  private readonly dir: string;
  private readonly ttlMs?: number;

  constructor(options: ConversationStoreOptions) {
    this.dir = resolve(options.dir);
    this.ttlMs = options.ttlMs;
  }

  async getOrCreate(conversationId: string | undefined, metadata: ConversationMetadata): Promise<ConversationRecord> {
    const existing = conversationId == null || conversationId === "" ? null : await this.get(conversationId);
    if (existing != null) {
      return existing;
    }
    const now = nowUTC();
    return {
      type: "marshall_chat_conversation",
      conversation_id: conversationId == null || conversationId === "" ? newConversationId() : safeConversationId(conversationId),
      created_at: now,
      updated_at: now,
      model: metadata.model,
      adapter_id: metadata.adapterId,
      adapter_hash: metadata.adapterHash,
      summary: "",
      messages: [],
    };
  }

  async get(conversationId: string): Promise<ConversationRecord | null> {
    const id = safeConversationId(conversationId);
    const path = this.pathFor(id);
    const fileStat = await stat(path).catch(() => null);
    if (fileStat == null || !fileStat.isFile()) {
      return null;
    }
    if (this.ttlMs != null && Date.now() - fileStat.mtimeMs > this.ttlMs) {
      return null;
    }
    return parseConversation(JSON.parse(await readFile(path, "utf8")));
  }

  async save(conversation: ConversationRecord): Promise<void> {
    const normalized = parseConversation(conversation);
    await mkdir(this.dir, { recursive: true });
    const path = this.pathFor(normalized.conversation_id);
    const tempPath = join(dirname(path), `.${normalized.conversation_id}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    await rename(tempPath, path);
  }

  async appendTurn(
    conversation: ConversationRecord,
    userContent: string,
    assistantContent: string,
    metadata: ConversationMetadata,
  ): Promise<ConversationRecord> {
    const now = nowUTC();
    const next: ConversationRecord = {
      ...conversation,
      model: metadata.model,
      adapter_id: metadata.adapterId,
      adapter_hash: metadata.adapterHash,
      updated_at: now,
      messages: [
        ...conversation.messages,
        { role: "user", content: nonEmptyString(userContent, "user message"), created_at: now },
        { role: "assistant", content: assistantContent, created_at: now },
      ],
    };
    await this.save(next);
    return next;
  }

  async context(
    conversationId: string | undefined,
    userContent: string,
    metadata: ConversationMetadata,
    options: { maxMessages?: number } = {},
  ): Promise<ConversationContext> {
    const conversation = await this.getOrCreate(conversationId, metadata);
    const maxMessages = options.maxMessages ?? DEFAULT_CONTEXT_MESSAGES;
    const candidateMessages: ConversationMessage[] = [
      ...conversation.messages,
      { role: "user", content: nonEmptyString(userContent, "user message"), created_at: nowUTC() },
    ];
    const contextMessages = candidateMessages.slice(-maxMessages);
    return {
      conversation,
      context_messages: contextMessages,
      prompt: conversationPrompt(conversation.summary, contextMessages),
    };
  }

  pathFor(conversationId: string): string {
    return join(this.dir, `${safeConversationId(conversationId)}.json`);
  }
}

export function publicConversation(conversation: ConversationRecord) {
  return {
    conversation_id: conversation.conversation_id,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    model: conversation.model,
    adapter_id: conversation.adapter_id,
    adapter_hash: conversation.adapter_hash,
    has_summary: conversation.summary.trim() !== "",
    messages: conversation.messages,
  };
}

export function conversationPrompt(summary: string, messages: ConversationMessage[]): string {
  const sections: string[] = [];
  if (summary.trim() !== "") {
    sections.push(`summary: ${summary.trim()}`);
  }
  sections.push(...messages.map((message) => `${message.role}: ${message.content}`));
  sections.push("assistant:");
  return sections.join("\n");
}

export function defaultConversationDir(): string {
  return resolve(process.cwd(), ".marshall/chat/conversations");
}

export function ttlDaysToMs(days: number): number {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`invalid conversation ttl days: ${days}`);
  }
  return Math.round(days * 24 * 60 * 60 * 1000);
}

function parseConversation(value: unknown): ConversationRecord {
  if (typeof value !== "object" || value == null) {
    throw new Error("conversation must be an object");
  }
  const record = value as Record<string, unknown>;
  const conversation: ConversationRecord = {
    type: "marshall_chat_conversation",
    conversation_id: safeConversationId(stringField(record.conversation_id, "conversation_id")),
    created_at: stringField(record.created_at, "created_at"),
    updated_at: stringField(record.updated_at, "updated_at"),
    model: stringField(record.model, "model"),
    adapter_id: stringField(record.adapter_id, "adapter_id"),
    adapter_hash: stringField(record.adapter_hash, "adapter_hash"),
    summary: typeof record.summary === "string" ? record.summary : "",
    messages: Array.isArray(record.messages) ? record.messages.map(parseMessage) : [],
  };
  return conversation;
}

function parseMessage(value: unknown): ConversationMessage {
  if (typeof value !== "object" || value == null) {
    throw new Error("conversation message must be an object");
  }
  const record = value as Record<string, unknown>;
  const role = record.role;
  if (role !== "system" && role !== "user" && role !== "assistant") {
    throw new Error("conversation message role must be system, user, or assistant");
  }
  return {
    role,
    content: stringField(record.content, "message.content"),
    created_at: typeof record.created_at === "string" && record.created_at !== "" ? record.created_at : nowUTC(),
  };
}

function safeConversationId(value: string): string {
  if (!CONVERSATION_ID_PATTERN.test(value)) {
    throw new Error("invalid conversation_id");
  }
  return value;
}

function newConversationId(): string {
  return `conv_${randomUUID()}`;
}

function nonEmptyString(value: string, field: string): string {
  if (value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function nowUTC(): string {
  return new Date().toISOString();
}
