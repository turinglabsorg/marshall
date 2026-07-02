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
  let workers: InferenceWorkerPeer[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-inference-p2p-"));
  });

  afterEach(async () => {
    if (server != null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await Promise.all(workers.map((worker) => worker.stop()));
    workers = [];
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
if (process.argv.includes("--stream-jsonl")) {
  emit({ type: "marshall_inference_stream_event", event: "started", model });
  emit({ type: "marshall_inference_stream_event", event: "chunk", text: "p2p stream chunk", raw_text: "p2p stream chunk" });
  emit({
    type: "marshall_inference_stream_event",
    event: "completed",
    model,
    prompt,
    text: "p2p stream answer: " + prompt,
    raw_text: "p2p stream answer: " + prompt,
    elapsed_ms: 12
  });
  process.exit(0);
}
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

function emit(payload) {
  console.log(JSON.stringify(payload));
}
`, "utf8");

    const worker = await InferenceWorkerPeer.create({
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
    workers.push(worker);

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
      worker_id: "macbook-inference-test",
    });
    expect(chat.conversation_id).toMatch(/^conv_/);

    const streamText = await fetch(`${baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "stream ping" }),
    }).then((response) => response.text());
    const streamEvents = eventsFromSse(streamText);
    expect(streamEvents.map((event) => event.name)).toEqual(["accepted", "started", "chunk", "completed", "done"]);
    expect(streamEvents.find((event) => event.name === "chunk")?.data).toMatchObject({
      worker_id: "macbook-inference-test",
      text: "p2p stream chunk",
    });
    expect((streamEvents.find((event) => event.name === "completed")?.data as any).prompt).toBeUndefined();
    expect(streamEvents.at(-1)?.data).toMatchObject({
      type: "marshall_chat_response",
      worker_id: "macbook-inference-test",
      prompt: "stream ping",
      text: "p2p stream answer: user: stream ping\nassistant:",
    });
  }, 15_000);

  it("selects compatible workers and fails over when the first generation fails", async () => {
    const publicDir = join(tempDir, "public");
    const adapterPath = join(tempDir, "adapter");
    const badRunnerPath = join(tempDir, "bad-runner.mjs");
    const goodRunnerPath = join(tempDir, "good-runner.mjs");
    await mkdir(publicDir);
    await mkdir(adapterPath);
    await writeFile(join(publicDir, "index.html"), "<!doctype html><title>marshall.chat</title>", "utf8");
    await writeFile(badRunnerPath, `
process.stderr.write("simulated worker failure\\n");
process.exit(2);
`, "utf8");
    await writeFile(goodRunnerPath, `
const prompt = value("--prompt");
const model = value("--model");
const adapterPath = value("--adapter-path");
console.log(JSON.stringify({
  type: "marshall_chat_completion",
  model,
  adapter_path: adapterPath,
  prompt,
  text: "good worker: " + prompt,
  raw_text: "good worker: " + prompt,
  elapsed_ms: 13
}));

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    throw new Error("missing " + flag);
  }
  return process.argv[index + 1];
}
`, "utf8");

    const badWorker = await InferenceWorkerPeer.create({
      privateKeyPath: join(tempDir, "bad-worker.key"),
      listen: ["/ip4/127.0.0.1/tcp/0"],
      workerId: "bad-inference-test",
      publicDir,
      runnerPath: badRunnerPath,
      pythonBin: process.execPath,
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterPath,
      adapterArtifactHash: "sha256:test-adapter",
      adapterId: "job_test_adapter",
      systemPrompt: "You are Marshall.",
      maxTokens: 64,
      temperature: 0.1,
    });
    const goodWorker = await InferenceWorkerPeer.create({
      privateKeyPath: join(tempDir, "good-worker.key"),
      listen: ["/ip4/127.0.0.1/tcp/0"],
      workerId: "good-inference-test",
      publicDir,
      runnerPath: goodRunnerPath,
      pythonBin: process.execPath,
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterPath,
      adapterArtifactHash: "sha256:test-adapter",
      adapterId: "job_test_adapter",
      systemPrompt: "You are Marshall.",
      maxTokens: 64,
      temperature: 0.1,
    });
    workers.push(badWorker, goodWorker);

    server = await createChatServer({
      publicDir,
      runnerPath: goodRunnerPath,
      pythonBin: process.execPath,
      runtime: "p2p_worker",
      p2pPrivateKeyPath: join(tempDir, "gateway.key"),
      p2pWorkerAddrs: [
        badWorker.multiaddrs[0].toString(),
        goodWorker.multiaddrs[0].toString(),
      ],
      p2pRequestTimeoutMs: 10_000,
      p2pProbeTimeoutMs: 10_000,
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

    const registry = await fetch(`${baseUrl}/api/inference/workers`).then((response) => response.json()) as any;
    expect(registry.workers.map((worker: any) => worker.status)).toEqual(["ready", "ready"]);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "route me" }),
    }).then((response) => response.json()) as any;

    expect(chat).toMatchObject({
      type: "marshall_chat_response",
      runtime: "p2p_worker",
      worker_id: "good-inference-test",
      text: "good worker: user: route me\nassistant:",
    });

    const after = await fetch(`${baseUrl}/api/inference/workers?refresh=false`).then((response) => response.json()) as any;
    expect(after.workers[0]).toMatchObject({
      worker_id: "bad-inference-test",
      failed_requests: 1,
    });
    expect(after.workers[1]).toMatchObject({
      worker_id: "good-inference-test",
      completed_requests: 1,
    });
  }, 20_000);

  it("routes each chat request to the worker serving the selected model package", async () => {
    const publicDir = join(tempDir, "public");
    const adapterPathA = join(tempDir, "adapter-a");
    const adapterPathB = join(tempDir, "adapter-b");
    const runnerPath = join(tempDir, "fake-runner.mjs");
    const registryPath = join(tempDir, "models", "index.json");
    await mkdir(publicDir);
    await mkdir(adapterPathA);
    await mkdir(adapterPathB);
    await mkdir(join(tempDir, "models"));
    await writeFile(join(publicDir, "index.html"), "<!doctype html><title>marshall.chat</title>", "utf8");
    await writeFile(runnerPath, `
const prompt = value("--prompt");
const model = value("--model");
console.log(JSON.stringify({
  type: "marshall_chat_completion",
  model,
  adapter_path: value("--adapter-path"),
  prompt,
  text: model + " answered: " + prompt,
  raw_text: model + " answered: " + prompt,
  elapsed_ms: 17
}));

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    throw new Error("missing " + flag);
  }
  return process.argv[index + 1];
}
`, "utf8");
    await writeFile(registryPath, JSON.stringify({
      type: "marshall_model_registry",
      version: 1,
      updated_at: "2026-07-01T00:00:00.000Z",
      models: [
        registryEntry("mlx-community/gemma-3-1b-it-4bit", "job_gemma_adapter", "sha256:gemma-adapter", "optimized_model_job_gemma_adapter", "sha256:gemma-package"),
        registryEntry("mlx-community/qwen2.5-0.5b-instruct-4bit", "job_qwen_adapter", "sha256:qwen-adapter", "optimized_model_job_qwen_adapter", "sha256:qwen-package"),
      ],
    }), "utf8");

    const gemmaWorker = await InferenceWorkerPeer.create({
      privateKeyPath: join(tempDir, "gemma-worker.key"),
      listen: ["/ip4/127.0.0.1/tcp/0"],
      workerId: "gemma-inference-test",
      publicDir,
      runnerPath,
      pythonBin: process.execPath,
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterPath: adapterPathA,
      adapterArtifactHash: "sha256:gemma-adapter",
      adapterId: "job_gemma_adapter",
      systemPrompt: "You are Marshall.",
      maxTokens: 64,
      temperature: 0.1,
    });
    const qwenWorker = await InferenceWorkerPeer.create({
      privateKeyPath: join(tempDir, "qwen-worker.key"),
      listen: ["/ip4/127.0.0.1/tcp/0"],
      workerId: "qwen-inference-test",
      publicDir,
      runnerPath,
      pythonBin: process.execPath,
      model: "mlx-community/qwen2.5-0.5b-instruct-4bit",
      adapterPath: adapterPathB,
      adapterArtifactHash: "sha256:qwen-adapter",
      adapterId: "job_qwen_adapter",
      systemPrompt: "You are Marshall.",
      maxTokens: 64,
      temperature: 0.1,
    });
    workers.push(gemmaWorker, qwenWorker);

    server = await createChatServer({
      publicDir,
      runnerPath,
      pythonBin: process.execPath,
      runtime: "p2p_worker",
      p2pPrivateKeyPath: join(tempDir, "gateway.key"),
      p2pWorkerAddrs: [
        gemmaWorker.multiaddrs[0].toString(),
        qwenWorker.multiaddrs[0].toString(),
      ],
      model: "mlx-community/gemma-3-1b-it-4bit",
      adapterArtifactHash: "sha256:gemma-adapter",
      adapterId: "job_gemma_adapter",
      systemPrompt: "You are Marshall.",
      maxTokens: 64,
      temperature: 0.1,
      conversationDir: join(tempDir, "conversations"),
      modelRegistryPath: registryPath,
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const models = await fetch(`${baseUrl}/api/models`).then((response) => response.json()) as any;
    expect(models.serving).toHaveLength(2);
    expect(models.serving.map((model: any) => [model.package_job_id, model.ready_workers])).toEqual([
      ["optimized_model_job_gemma_adapter", 1],
      ["optimized_model_job_qwen_adapter", 1],
    ]);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "use the selected package",
        model_package_id: "optimized_model_job_qwen_adapter",
      }),
    }).then((response) => response.json()) as any;

    expect(chat).toMatchObject({
      type: "marshall_chat_response",
      model: "mlx-community/qwen2.5-0.5b-instruct-4bit",
      adapter_id: "job_qwen_adapter",
      adapter_hash: "sha256:qwen-adapter",
      model_package_id: "optimized_model_job_qwen_adapter",
      worker_id: "qwen-inference-test",
      text: "mlx-community/qwen2.5-0.5b-instruct-4bit answered: user: use the selected package\nassistant:",
    });

    const after = await fetch(`${baseUrl}/api/inference/workers?refresh=false`).then((response) => response.json()) as any;
    expect(after.workers.find((worker: any) => worker.worker_id === "gemma-inference-test")).toMatchObject({
      completed_requests: 0,
    });
    expect(after.workers.find((worker: any) => worker.worker_id === "qwen-inference-test")).toMatchObject({
      completed_requests: 1,
    });
  }, 20_000);
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

function registryEntry(
  baseModel: string,
  adapterId: string,
  adapterHash: string,
  packageJobId: string,
  packageHash: string,
) {
  return {
    status: "ready",
    run_id: `run_${adapterId}`,
    created_at: "2026-07-01T00:00:00.000Z",
    base_model: baseModel,
    adapter_id: adapterId,
    adapter_uri: `marshall-artifact://${adapterId}`,
    adapter_artifact_hash: adapterHash,
    package_job_id: packageJobId,
    package_uri: `marshall-artifact://${packageJobId}`,
    package_artifact_hash: packageHash,
    eval: {
      job_id: `job_eval_${adapterId}`,
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
  };
}
