import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileConversationStore } from "../src/chat-memory.js";

describe("chat memory store", () => {
  it("persists conversations on disk and trims context windows", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-chat-memory-"));
    const store = new FileConversationStore({ dir: tempDir });
    const metadata = {
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterId: "job_test_adapter",
      adapterHash: "sha256:test-adapter",
    };

    const firstContext = await store.context(undefined, "first question", metadata, { maxMessages: 4 });
    const first = await store.appendTurn(firstContext.conversation, "first question", "first answer", metadata);
    await store.appendTurn(first, "second question", "second answer", metadata);

    const loaded = await store.get(first.conversation_id);
    expect(loaded?.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:first question",
      "assistant:first answer",
      "user:second question",
      "assistant:second answer",
    ]);

    const nextContext = await store.context(first.conversation_id, "third question", metadata, { maxMessages: 3 });
    expect(nextContext.context_messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:second question",
      "assistant:second answer",
      "user:third question",
    ]);
    expect(nextContext.prompt).toContain("assistant: second answer");
    expect(JSON.parse(await readFile(store.pathFor(first.conversation_id), "utf8")).conversation_id).toBe(first.conversation_id);
  });

  it("persists long-term memory and includes active items in the bounded prompt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-chat-memory-"));
    const store = new FileConversationStore({ dir: tempDir });
    const metadata = {
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterId: "job_test_adapter",
      adapterHash: "sha256:test-adapter",
    };

    const created = await store.getOrCreate(undefined, metadata);
    const updated = await store.updateMemory(created.conversation_id, {
      summary: "The user is building Marshall as a distributed training and inference network.",
      plans: ["Keep inference workers stateless", "Persist long-term conversation state in the gateway"],
      facts: ["marshall.chat routes prompts over libp2p"],
      open_tasks: [{ text: "Add semantic memory retrieval", status: "active" }],
      preferences: ["Prefer bounded gateway-owned memory"],
    }, metadata);

    expect(updated.memory.plans).toHaveLength(2);
    expect(updated.summary).toContain("distributed training");

    const loaded = await store.get(created.conversation_id);
    expect(loaded?.memory.facts[0]?.text).toBe("marshall.chat routes prompts over libp2p");

    const context = await store.context(created.conversation_id, "what should we do next?", metadata, { maxMemoryItems: 4 });
    expect(context.prompt).toContain("long_term_memory:");
    expect(context.prompt).toContain("plans:");
    expect(context.prompt).toContain("Keep inference workers stateless");
    expect(context.prompt).toContain("facts:");
    expect(context.prompt).toContain("Add semantic memory retrieval");
    expect(context.prompt).not.toContain("Prefer bounded gateway-owned memory");
  });

  it("rejects unsafe conversation ids", async () => {
    const store = new FileConversationStore({ dir: await mkdtemp(join(tmpdir(), "marshall-chat-memory-")) });
    await expect(store.get("../secrets")).rejects.toThrow("invalid conversation_id");
  });
});
