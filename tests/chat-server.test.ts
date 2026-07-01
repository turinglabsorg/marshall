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
    await mkdir(publicDir);
    await mkdir(adapterPath);
    await writeFile(join(publicDir, "index.html"), "<!doctype html><title>marshall.chat</title>", "utf8");
    await writeFile(runnerPath, `
const prompt = value("--prompt");
const model = value("--model");
const adapterPath = value("--adapter-path");
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

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "When did Virgin Australia start operating?" },
        ],
      }),
    }).then((response) => response.json());

    expect(chat).toMatchObject({
      type: "marshall_chat_response",
      adapter_id: "job_test_adapter",
      text: "answer: user: When did Virgin Australia start operating?\nassistant:",
      elapsed_ms: 7,
    });
  });
});
