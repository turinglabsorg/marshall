import type { Libp2p, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { createMarshallNode } from "./node.js";
import { PROTOCOLS } from "./protocols.js";
import { InferenceRequestSchema, InferenceResponseSchema } from "./schemas.js";
import {
  defaultChatPublicDir,
  defaultChatRunnerPath,
  resolveChatConfig,
  runInference,
  type ChatServerConfig,
  type ResolvedChatServerConfig,
} from "./chat-server.js";
import { readJson, writeJson } from "./wire.js";

export interface InferenceWorkerOptions {
  privateKeyPath: string;
  listen?: string[];
  workerId?: string;
  publicDir?: string;
  runnerPath?: string;
  pythonBin: string;
  modelPackagePath?: string;
  model?: string;
  adapterPath?: string;
  adapterArtifactHash?: string;
  adapterId?: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

export class InferenceWorkerPeer {
  private constructor(
    readonly node: Libp2p,
    readonly config: ResolvedChatServerConfig,
    private readonly workerId?: string,
  ) {}

  static async create(options: InferenceWorkerOptions): Promise<InferenceWorkerPeer> {
    const config: ChatServerConfig = {
      publicDir: options.publicDir ?? defaultChatPublicDir(),
      runnerPath: options.runnerPath ?? defaultChatRunnerPath(),
      pythonBin: options.pythonBin,
      modelPackagePath: options.modelPackagePath,
      model: options.model,
      adapterPath: options.adapterPath,
      adapterArtifactHash: options.adapterArtifactHash,
      adapterId: options.adapterId,
      systemPrompt: options.systemPrompt,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      runtime: "local_process",
    };
    const resolved = await resolveChatConfig(config);
    const node = await createMarshallNode({
      privateKeyPath: options.privateKeyPath,
      listen: options.listen ?? ["/ip4/0.0.0.0/tcp/8788"],
    });
    const peer = new InferenceWorkerPeer(node, resolved, options.workerId);
    await peer.registerHandlers();
    return peer;
  }

  get peerId(): string {
    return this.node.peerId.toString();
  }

  get multiaddrs(): Multiaddr[] {
    return this.node.getMultiaddrs();
  }

  async stop(): Promise<void> {
    await this.node.stop();
  }

  private async registerHandlers(): Promise<void> {
    await this.node.handle(PROTOCOLS.inferenceGenerate, (stream) => this.handleGenerate(stream));
  }

  private async handleGenerate(stream: Stream): Promise<void> {
    const startedAt = Date.now();
    try {
      const request = InferenceRequestSchema.parse(await readJson(stream));
      const result = await runInference({
        runnerPath: this.config.runnerPath,
        pythonBin: this.config.pythonBin,
        model: this.config.model,
        adapterPath: this.config.adapterPath!,
        systemPrompt: request.system_prompt ?? this.config.systemPrompt,
        prompt: request.prompt,
        maxTokens: request.max_tokens ?? this.config.maxTokens,
        temperature: request.temperature ?? this.config.temperature,
      });
      await writeJson(stream, InferenceResponseSchema.parse({
        type: "marshall_inference_response",
        accepted: true,
        peer_id: this.peerId,
        worker_id: this.workerId,
        model: this.config.model,
        adapter_id: this.config.adapterId,
        adapter_hash: this.config.adapterArtifactHash,
        prompt: request.prompt,
        text: result.text,
        raw_text: result.raw_text,
        elapsed_ms: result.elapsed_ms,
      }));
    } catch (error) {
      await writeJson(stream, InferenceResponseSchema.parse({
        type: "marshall_inference_response",
        accepted: false,
        peer_id: this.peerId,
        worker_id: this.workerId,
        model: this.config.model,
        adapter_id: this.config.adapterId,
        adapter_hash: this.config.adapterArtifactHash,
        elapsed_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "inference worker failed",
      }));
    }
  }
}
