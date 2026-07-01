import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createChatServer } from "../src/chat-server.js";
import type { Server } from "node:http";

describe("marshall.chat local server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server != null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("serves health and routes chat requests through the configured runner", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-chat-server-"));
    const publicDir = join(tempDir, "public");
    const adapterPath = join(tempDir, "adapter");
    const runnerPath = join(tempDir, "fake-runner.mjs");
    const conversationDir = join(tempDir, "conversations");
    const registryPath = join(tempDir, "models", "index.json");
    await mkdir(publicDir);
    await mkdir(adapterPath);
    await mkdir(join(tempDir, "models"));
    await writeFile(join(publicDir, "index.html"), "<!doctype html><title>marshall.chat</title>", "utf8");
    await writeFile(registryPath, JSON.stringify({
      type: "marshall_model_registry",
      version: 1,
      updated_at: "2026-07-01T00:00:00.000Z",
      models: [{
        status: "ready",
        run_id: "run_chat_registry_test",
        created_at: "2026-07-01T00:00:00.000Z",
        base_model: "mlx-community/gemma-3-1b-it-4bit",
        adapter_id: "job_test_adapter",
        adapter_uri: "marshall-artifact://job_test_adapter",
        adapter_artifact_hash: "sha256:test-adapter",
        package_job_id: "optimized_model_job_test_adapter",
        package_uri: "marshall-artifact://optimized_model_job_test_adapter",
        package_artifact_hash: "sha256:test-package",
        eval: {
          job_id: "job_eval_test",
          eval_shard_id: "instruction_terms_jsonl",
          examples: 4,
          correct: 3,
          accuracy: 0.75,
          invalid: 0,
          invalid_rate: 0,
          score: 0.75,
          metrics_path: "/tmp/metrics.json",
        },
        transfer: {
          protocol: "/marshall/artifact/fetch/1.0.0",
          chunked: true,
          hash_verified: true,
          https_payload: false,
        },
      }],
    }), "utf8");
    await writeFile(runnerPath, `
const prompt = value("--prompt");
const model = value("--model");
const adapterPath = value("--adapter-path");
if (process.argv.includes("--stream-jsonl")) {
  emit({ type: "marshall_inference_stream_event", event: "started", model });
  emit({ type: "marshall_inference_stream_event", event: "chunk", text: "stream chunk", raw_text: "stream chunk" });
  emit({
    type: "marshall_inference_stream_event",
    event: "completed",
    model,
    prompt,
    text: "stream answer: " + prompt,
    raw_text: "stream answer: " + prompt,
    elapsed_ms: 9
  });
  process.exit(0);
}
console.log(JSON.stringify({
  type: "marshall_chat_completion",
  model,
  adapter_path: adapterPath,
  prompt,
  text: "answer: " + prompt,
  raw_text: "answer: " + prompt,
  elapsed_ms: 7
}));

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    throw new Error("missing " + flag);
  }
  return process.argv[index + 1];
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}
`, "utf8");

    server = await createChatServer({
      publicDir,
      runnerPath,
      pythonBin: process.execPath,
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterPath,
      adapterArtifactHash: "sha256:test-adapter",
      adapterId: "job_test_adapter",
      systemPrompt: "You are Marshall.",
      maxTokens: 64,
      temperature: 0.1,
      conversationDir,
      modelRegistryPath: registryPath,
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    expect(health).toMatchObject({
      type: "marshall_chat_health",
      ready: true,
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapter_id: "job_test_adapter",
      adapter_hash: "sha256:test-adapter",
    });

    const models = await fetch(`${baseUrl}/api/models`).then((response) => response.json()) as any;
    expect(models.models[0]).toMatchObject({
      base_model: "mlx-community/gemma-3-1b-it-4bit",
      adapter_id: "job_test_adapter",
      package_uri: "marshall-artifact://optimized_model_job_test_adapter",
      transfer: {
        protocol: "/marshall/artifact/fetch/1.0.0",
        https_payload: false,
      },
    });
    expect(models.serving[0].selected).toBe(true);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "When did Virgin Australia start operating?" },
        ],
      }),
    }).then((response) => response.json()) as any;

    expect(chat).toMatchObject({
      type: "marshall_chat_response",
      adapter_id: "job_test_adapter",
      text: "answer: user: When did Virgin Australia start operating?\nassistant:",
      elapsed_ms: 7,
    });
    expect(chat.conversation_id).toMatch(/^conv_/);
    expect(chat.conversation.messages).toHaveLength(2);
    expect(chat.conversation.messages[0]).toMatchObject({
      role: "user",
      content: "When did Virgin Australia start operating?",
    });

    const persisted = await fetch(`${baseUrl}/api/conversation?conversation_id=${encodeURIComponent(chat.conversation_id)}`).then((response) => response.json()) as any;
    expect(persisted.conversation.messages).toHaveLength(2);

    const memory = await fetch(`${baseUrl}/api/conversation/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: chat.conversation_id,
        memory: {
          summary: "Marshall chat should keep durable gateway-owned memory.",
          plans: ["Keep inference workers stateless"],
          facts: ["The current model package is under test"],
          open_tasks: ["Add semantic retrieval later"],
        },
      }),
    }).then((response) => response.json()) as any;
    expect(memory.conversation.memory.plans[0]).toMatchObject({
      text: "Keep inference workers stateless",
      status: "active",
    });

    const followUp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: chat.conversation_id,
        prompt: "Answer again.",
      }),
    }).then((response) => response.json()) as any;

    expect(followUp.conversation.messages).toHaveLength(4);
    expect(followUp.text).toContain("long_term_memory:");
    expect(followUp.text).toContain("Keep inference workers stateless");
    expect(followUp.text).toContain("assistant: answer: user: When did Virgin Australia start operating?");
    expect(followUp.text).toContain("user: Answer again.");

    const streamText = await fetch(`${baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: chat.conversation_id,
        prompt: "Stream answer.",
      }),
    }).then((response) => response.text());
    const streamEvents = eventsFromSse(streamText);
    expect(streamEvents.map((event) => event.name)).toEqual(["accepted", "started", "chunk", "completed", "done"]);
    const completed = streamEvents.find((event) => event.name === "completed")?.data as any;
    expect(completed.prompt).toBeUndefined();
    const done = streamEvents.at(-1)?.data as any;
    expect(done.text).toContain("stream answer:");
    expect(done.prompt).toBe("Stream answer.");
    expect(done.conversation.messages).toHaveLength(6);
  });
});

function eventsFromSse(value: string): Array<{ name: string; data: unknown }> {
  return value.trim().split("\n\n").map((block) => {
    const lines = block.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event:"));
    const dataLine = lines.find((line) => line.startsWith("data:"));
    return {
      name: eventLine?.slice("event:".length).trim() ?? "message",
      data: JSON.parse(dataLine?.slice("data:".length).trim() ?? "{}"),
    };
  });
}
