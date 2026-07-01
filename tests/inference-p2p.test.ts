import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatServer } from "../src/chat-server.js";
import { InferenceWorkerPeer } from "../src/inference-worker.js";

describe("marshall.chat p2p inference", () => {
  let tempDir: string;
  let server: Server | undefined;
  let worker: InferenceWorkerPeer | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-inference-p2p-"));
  });

  afterEach(async () => {
    if (server != null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await worker?.stop();
    worker = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("routes chat requests from the gateway to an inference worker over libp2p", async () => {
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
  text: "p2p answer: " + prompt,
  raw_text: "p2p answer: " + prompt,
  elapsed_ms: 11
}));

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    throw new Error("missing " + flag);
  }
  return process.argv[index + 1];
}
`, "utf8");

    worker = await InferenceWorkerPeer.create({
      privateKeyPath: join(tempDir, "worker.key"),
      listen: ["/ip4/127.0.0.1/tcp/0"],
      workerId: "macbook-inference-test",
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

    server = await createChatServer({
      publicDir,
      runnerPath,
      pythonBin: process.execPath,
      runtime: "p2p_worker",
      p2pPrivateKeyPath: join(tempDir, "gateway.key"),
      p2pWorkerAddr: worker.multiaddrs[0].toString(),
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterArtifactHash: "sha256:test-adapter",
      adapterId: "job_test_adapter",
      systemPrompt: "You are Marshall.",
      maxTokens: 64,
      temperature: 0.1,
      conversationDir: join(tempDir, "conversations"),
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    expect(health).toMatchObject({
      type: "marshall_chat_health",
      ready: true,
      runtime: "p2p_worker",
      adapter_id: "job_test_adapter",
      adapter_hash: "sha256:test-adapter",
    });

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "ping" }),
    }).then((response) => response.json()) as any;

    expect(chat).toMatchObject({
      type: "marshall_chat_response",
      runtime: "p2p_worker",
      adapter_id: "job_test_adapter",
      adapter_hash: "sha256:test-adapter",
      text: "p2p answer: user: ping\nassistant:",
      elapsed_ms: 11,
    });
    expect(chat.conversation_id).toMatch(/^conv_/);
  }, 15_000);
});
