import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ConversationRole = "system" | "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  created_at: string;
}

export type LongTermMemorySection = "facts" | "preferences" | "goals" | "open_tasks" | "plans";
export type LongTermMemoryStatus = "active" | "done" | "archived";

export interface LongTermMemoryItem {
  id: string;
  text: string;
  created_at: string;
  updated_at: string;
  status: LongTermMemoryStatus;
}

export interface LongTermMemory {
  type: "marshall_chat_long_term_memory";
  updated_at: string;
  summary: string;
  facts: LongTermMemoryItem[];
  preferences: LongTermMemoryItem[];
  goals: LongTermMemoryItem[];
  open_tasks: LongTermMemoryItem[];
  plans: LongTermMemoryItem[];
}

export interface LongTermMemoryUpdate {
  summary?: string;
  facts?: unknown[];
  preferences?: unknown[];
  goals?: unknown[];
  open_tasks?: unknown[];
  plans?: unknown[];
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
  memory: LongTermMemory;
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
const DEFAULT_MEMORY_ITEMS = 24;
const MAX_MEMORY_ITEMS_PER_SECTION = 64;
const MAX_MEMORY_TEXT_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 6000;
const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,96}$/;
const MEMORY_SECTIONS: LongTermMemorySection[] = ["plans", "open_tasks", "goals", "facts", "preferences"];

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
    const memory = emptyLongTermMemory(now);
    return {
      type: "marshall_chat_conversation",
      conversation_id: conversationId == null || conversationId === "" ? newConversationId() : safeConversationId(conversationId),
      created_at: now,
      updated_at: now,
      model: metadata.model,
      adapter_id: metadata.adapterId,
      adapter_hash: metadata.adapterHash,
      summary: "",
      memory,
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
      summary: conversation.memory.summary,
      memory: conversation.memory,
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

  async updateMemory(
    conversationId: string,
    update: LongTermMemoryUpdate,
    metadata: ConversationMetadata,
  ): Promise<ConversationRecord> {
    const conversation = await this.getOrCreate(conversationId, metadata);
    const memory = mergeLongTermMemory(conversation.memory, update);
    const next: ConversationRecord = {
      ...conversation,
      model: metadata.model,
      adapter_id: metadata.adapterId,
      adapter_hash: metadata.adapterHash,
      updated_at: memory.updated_at,
      summary: memory.summary,
      memory,
    };
    await this.save(next);
    return next;
  }

  async context(
    conversationId: string | undefined,
    userContent: string,
    metadata: ConversationMetadata,
    options: { maxMessages?: number; maxMemoryItems?: number } = {},
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
      prompt: conversationPrompt(conversation.memory, contextMessages, {
        maxMemoryItems: options.maxMemoryItems ?? DEFAULT_MEMORY_ITEMS,
      }),
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
    has_summary: conversation.memory.summary.trim() !== "",
    memory: publicLongTermMemory(conversation.memory),
    messages: conversation.messages,
  };
}

export function conversationPrompt(
  memory: LongTermMemory | string,
  messages: ConversationMessage[],
  options: { maxMemoryItems?: number } = {},
): string {
  const sections: string[] = [];
  const normalizedMemory = typeof memory === "string" ? memoryFromSummary(memory) : memory;
  const memoryPrompt = longTermMemoryPrompt(normalizedMemory, options.maxMemoryItems ?? DEFAULT_MEMORY_ITEMS);
  if (memoryPrompt !== "") {
    sections.push(memoryPrompt);
  }
  sections.push(...messages.map((message) => `${message.role}: ${message.content}`));
  sections.push("assistant:");
  return sections.join("\n");
}

export function longTermMemoryPrompt(memory: LongTermMemory, maxItems: number = DEFAULT_MEMORY_ITEMS): string {
  const lines: string[] = [];
  if (memory.summary.trim() !== "") {
    lines.push(`summary: ${memory.summary.trim()}`);
  }
  let remaining = Math.max(0, maxItems);
  for (const section of MEMORY_SECTIONS) {
    if (remaining <= 0) {
      break;
    }
    const activeItems = memory[section]
      .filter((item) => item.status === "active" && item.text.trim() !== "")
      .slice(0, remaining);
    if (activeItems.length === 0) {
      continue;
    }
    lines.push(`${section}:`);
    for (const item of activeItems) {
      lines.push(`- ${item.text.trim()}`);
    }
    remaining -= activeItems.length;
  }
  return lines.length === 0 ? "" : `long_term_memory:\n${lines.join("\n")}`;
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
  const legacySummary = typeof record.summary === "string" ? record.summary : "";
  const memory = parseLongTermMemory(record.memory, legacySummary);
  const conversation: ConversationRecord = {
    type: "marshall_chat_conversation",
    conversation_id: safeConversationId(stringField(record.conversation_id, "conversation_id")),
    created_at: stringField(record.created_at, "created_at"),
    updated_at: stringField(record.updated_at, "updated_at"),
    model: stringField(record.model, "model"),
    adapter_id: stringField(record.adapter_id, "adapter_id"),
    adapter_hash: stringField(record.adapter_hash, "adapter_hash"),
    summary: memory.summary,
    memory,
    messages: Array.isArray(record.messages) ? record.messages.map(parseMessage) : [],
  };
  return conversation;
}

function parseLongTermMemory(value: unknown, legacySummary: string): LongTermMemory {
  const now = nowUTC();
  if (typeof value !== "object" || value == null) {
    return memoryFromSummary(legacySummary, now);
  }
  const record = value as Record<string, unknown>;
  return {
    type: "marshall_chat_long_term_memory",
    updated_at: typeof record.updated_at === "string" && record.updated_at !== "" ? record.updated_at : now,
    summary: boundedText(typeof record.summary === "string" ? record.summary : legacySummary, MAX_SUMMARY_LENGTH),
    facts: parseMemoryItems(record.facts, now),
    preferences: parseMemoryItems(record.preferences, now),
    goals: parseMemoryItems(record.goals, now),
    open_tasks: parseMemoryItems(record.open_tasks, now),
    plans: parseMemoryItems(record.plans, now),
  };
}

function parseMemoryItems(value: unknown, now: string): LongTermMemoryItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_MEMORY_ITEMS_PER_SECTION).map((item) => parseMemoryItem(item, now));
}

function parseMemoryItem(value: unknown, now: string): LongTermMemoryItem {
  if (typeof value === "string") {
    return newMemoryItem(value, now);
  }
  if (typeof value !== "object" || value == null) {
    throw new Error("memory item must be a string or object");
  }
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === "string" && record.id !== "" ? safeMemoryItemId(record.id) : newMemoryItemId(),
    text: boundedRequiredText(stringField(record.text, "memory item text"), MAX_MEMORY_TEXT_LENGTH, "memory item text"),
    created_at: typeof record.created_at === "string" && record.created_at !== "" ? record.created_at : now,
    updated_at: typeof record.updated_at === "string" && record.updated_at !== "" ? record.updated_at : now,
    status: memoryStatus(record.status),
  };
}

function mergeLongTermMemory(existing: LongTermMemory, update: LongTermMemoryUpdate): LongTermMemory {
  const now = nowUTC();
  const next: LongTermMemory = {
    ...existing,
    updated_at: now,
    summary: update.summary == null ? existing.summary : boundedText(String(update.summary), MAX_SUMMARY_LENGTH),
  };
  for (const section of MEMORY_SECTIONS) {
    if (update[section] == null) {
      continue;
    }
    next[section] = normalizeMemoryUpdateItems(update[section], existing[section], now);
  }
  return next;
}

function normalizeMemoryUpdateItems(value: unknown, existing: LongTermMemoryItem[], now: string): LongTermMemoryItem[] {
  if (!Array.isArray(value)) {
    throw new Error("memory sections must be arrays");
  }
  return value
    .slice(0, MAX_MEMORY_ITEMS_PER_SECTION)
    .map((item) => normalizeMemoryUpdateItem(item, existing, now))
    .filter((item) => item != null);
}

function normalizeMemoryUpdateItem(value: unknown, existing: LongTermMemoryItem[], now: string): LongTermMemoryItem | null {
  if (typeof value === "string") {
    const text = boundedText(value, MAX_MEMORY_TEXT_LENGTH).trim();
    if (text === "") {
      return null;
    }
    const matching = existing.find((item) => item.text === text);
    return matching == null ? newMemoryItem(text, now) : { ...matching, updated_at: now };
  }
  if (typeof value !== "object" || value == null) {
    throw new Error("memory item must be a string or object");
  }
  const record = value as Record<string, unknown>;
  const text = boundedRequiredText(stringField(record.text, "memory item text"), MAX_MEMORY_TEXT_LENGTH, "memory item text");
  const id = typeof record.id === "string" && record.id !== "" ? safeMemoryItemId(record.id) : undefined;
  const previous = id == null ? undefined : existing.find((item) => item.id === id);
  return {
    id: id ?? previous?.id ?? newMemoryItemId(),
    text,
    created_at: previous?.created_at ?? (typeof record.created_at === "string" && record.created_at !== "" ? record.created_at : now),
    updated_at: now,
    status: memoryStatus(record.status),
  };
}

function publicLongTermMemory(memory: LongTermMemory) {
  return {
    updated_at: memory.updated_at,
    summary: memory.summary,
    facts: memory.facts,
    preferences: memory.preferences,
    goals: memory.goals,
    open_tasks: memory.open_tasks,
    plans: memory.plans,
  };
}

function emptyLongTermMemory(now: string = nowUTC()): LongTermMemory {
  return {
    type: "marshall_chat_long_term_memory",
    updated_at: now,
    summary: "",
    facts: [],
    preferences: [],
    goals: [],
    open_tasks: [],
    plans: [],
  };
}

function memoryFromSummary(summary: string, now: string = nowUTC()): LongTermMemory {
  return {
    ...emptyLongTermMemory(now),
    summary: boundedText(summary, MAX_SUMMARY_LENGTH),
  };
}

function newMemoryItem(text: string, now: string): LongTermMemoryItem {
  return {
    id: newMemoryItemId(),
    text: boundedRequiredText(text, MAX_MEMORY_TEXT_LENGTH, "memory item text"),
    created_at: now,
    updated_at: now,
    status: "active",
  };
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

function safeMemoryItemId(value: string): string {
  if (!CONVERSATION_ID_PATTERN.test(value)) {
    throw new Error("invalid memory item id");
  }
  return value;
}

function newConversationId(): string {
  return `conv_${randomUUID()}`;
}

function newMemoryItemId(): string {
  return `mem_${randomUUID()}`;
}

function nonEmptyString(value: string, field: string): string {
  if (value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function boundedRequiredText(value: string, maxLength: number, field: string): string {
  const text = boundedText(value, maxLength).trim();
  if (text === "") {
    throw new Error(`${field} is required`);
  }
  return text;
}

function boundedText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function memoryStatus(value: unknown): LongTermMemoryStatus {
  if (value === "active" || value === "done" || value === "archived") {
    return value;
  }
  return "active";
}

function nowUTC(): string {
  return new Date().toISOString();
}
