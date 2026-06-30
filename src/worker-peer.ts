import type { Libp2p, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { readFile } from "node:fs/promises";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import {
  artifactBundleManifestResponse,
  createArtifactBundle,
  readArtifactBundleChunk,
  storeFetchedArtifact,
  type ArtifactBundle,
} from "./artifact-transfer.js";
import { publicKeyBase64 } from "./identity.js";
import { createMarshallNode } from "./node.js";
import { PROTOCOLS } from "./protocols.js";
import {
  AckSchema,
  ArtifactFetchChunkResponseSchema,
  ArtifactFetchManifestResponseSchema,
  ArtifactFetchRequestSchema,
  ArtifactManifestSchema,
  JobClaimResponseSchema,
  WorkerRegistrationResponseSchema,
  type ArtifactManifest,
  type Backend,
  type JobClaimResponse,
  type JobType,
  type JobStatus,
  type WorkerHeartbeat,
  type WorkerRegistration,
} from "./schemas.js";
import { readJson, requestJson, writeJson } from "./wire.js";

export interface WorkerPeerOptions {
  privateKeyPath: string;
  workerId: string;
  controlAddr: Multiaddr;
  controlAddrs?: Multiaddr[];
  listen?: string[];
  backend?: Backend;
  supportedJobs?: JobType[];
  memoryGb?: number;
  tokensPerSecond?: number;
  swarmToken?: string;
}

export class WorkerPeer {
  private readonly artifacts = new Map<string, ArtifactManifest>();
  private readonly artifactBundles = new Map<string, ArtifactBundle>();
  private activeControlAddr?: Multiaddr;

  private constructor(
    readonly node: Libp2p,
    private readonly options: WorkerPeerOptions,
  ) {}

  static async create(options: WorkerPeerOptions): Promise<WorkerPeer> {
    const controlAddrs = workerControlAddrs(options);
    const node = await createMarshallNode({
      privateKeyPath: options.privateKeyPath,
      listen: options.listen ?? ["/ip4/127.0.0.1/tcp/0"],
      bootstrapAddrs: controlAddrs.map((addr) => addr.toString()),
    });
    const peer = new WorkerPeer(node, options);
    await peer.registerHandlers();
    return peer;
  }

  get peerId(): string {
    return this.node.peerId.toString();
  }

  async stop(): Promise<void> {
    await this.node.stop();
  }

  async register(): Promise<WorkerRegistration> {
    const registration: WorkerRegistration = {
      ...this.authPayload(),
      peer_id: this.peerId,
      worker_id: this.options.workerId,
      public_key: await this.publicKey(),
      backend: this.options.backend ?? "cpu",
      device_family: this.options.backend === "mlx" ? "apple_silicon" : "generic_cpu",
      memory_gb: this.options.memoryGb ?? 32,
      supported_jobs: this.options.supportedJobs ?? ["train_toy_model", "evaluate_model", "tokenize_dataset"],
      benchmarks: {
        tokens_per_second: this.options.tokensPerSecond ?? 1000,
      },
    };

    const response = WorkerRegistrationResponseSchema.parse(
      await this.requestControlJson(PROTOCOLS.workerRegister, registration),
    );

    if (!response.accepted) {
      throw new Error(`worker registration rejected: ${registration.worker_id}`);
    }

    return registration;
  }

  async heartbeat(
    status: "idle" | "working" = "idle",
    jobId?: string,
    leaseSeconds?: number,
    telemetry: Partial<Pick<
      WorkerHeartbeat,
      "progress_percent" | "progress_label" | "work_units_done" | "work_units_total" | "throughput_units_per_second" | "throughput_label"
    >> = {},
  ): Promise<void> {
    const response = AckSchema.parse(
      await this.requestControlJson(PROTOCOLS.workerHeartbeat, {
        ...this.authPayload(),
        peer_id: this.peerId,
        worker_id: this.options.workerId,
        status,
        job_id: jobId,
        timestamp: new Date().toISOString(),
        lease_seconds: leaseSeconds,
        ...telemetry,
      }),
    );

    if (!response.accepted) {
      throw new Error(`heartbeat rejected: ${response.reason ?? "unknown reason"}`);
    }
  }

  async claimJob(jobType: JobType, maxTokens = 2_000): Promise<JobClaimResponse> {
    return JobClaimResponseSchema.parse(
      await this.requestControlJson(PROTOCOLS.jobClaim, {
        ...this.authPayload(),
        peer_id: this.peerId,
        worker_id: this.options.workerId,
        job_type: jobType,
        backend: this.options.backend ?? "cpu",
        max_tokens: maxTokens,
      }),
    );
  }

  async claimToyTrainingJob(maxTokens = 2_000): Promise<JobClaimResponse> {
    return this.claimJob("train_toy_model", maxTokens);
  }

  async claimMlxSmokeJob(maxTokens = 4): Promise<JobClaimResponse> {
    return this.claimJob("train_mlx_smoke", maxTokens);
  }

  async reportJobStatus(status: Omit<JobStatus, "peer_id" | "worker_id">): Promise<void> {
    const response = AckSchema.parse(
      await this.requestControlJson(PROTOCOLS.jobStatus, {
        ...this.authPayload(),
        peer_id: this.peerId,
        worker_id: this.options.workerId,
        ...status,
      }),
    );

    if (!response.accepted) {
      throw new Error(`job status rejected: ${response.reason ?? "unknown reason"}`);
    }
  }

  async publishArtifactManifest(manifest: Omit<ArtifactManifest, "peer_id" | "worker_id">): Promise<void> {
    const payload = ArtifactManifestSchema.parse({
      ...this.authPayload(),
      peer_id: this.peerId,
      worker_id: this.options.workerId,
      ...manifest,
    });
    const { auth_token: _authToken, ...storedPayload } = payload;
    this.artifacts.set(payload.job_id, ArtifactManifestSchema.parse(storedPayload));
    const response = AckSchema.parse(
      await this.requestControlJson(PROTOCOLS.artifactManifest, payload),
    );

    if (!response.accepted) {
      throw new Error(`artifact manifest rejected: ${response.reason ?? "unknown reason"}`);
    }
  }

  async fetchArtifactFromControl(
    jobId: string,
    artifactHash: string,
    outputRoot: string,
    options: { chunkBytes?: number; maxChunkRetries?: number } = {},
  ): Promise<ArtifactManifest> {
    const bundle = ArtifactFetchManifestResponseSchema.parse(await this.requestControlJson(
      PROTOCOLS.artifactFetch,
      {
        ...this.authPayload(),
        request_type: "manifest",
        job_id: jobId,
        artifact_hash: artifactHash,
      },
      { timeoutMs: 30_000 },
    ));
    if (!bundle.accepted) {
      throw new Error(`artifact fetch rejected: ${bundle.reason ?? "unknown reason"}`);
    }

    return storeFetchedArtifact({
      manifest: bundle.manifest,
      bundle,
      outputRoot,
      chunkBytes: options.chunkBytes,
      maxChunkRetries: options.maxChunkRetries,
      fetchChunk: async (request) => ArtifactFetchChunkResponseSchema.parse(await this.requestControlJson(
        PROTOCOLS.artifactFetch,
        {
          ...this.authPayload(),
          ...request,
        },
        { timeoutMs: 30_000 },
      )),
    });
  }

  private async registerHandlers(): Promise<void> {
    await this.node.handle(PROTOCOLS.artifactFetch, (stream) => this.handleArtifactFetch(stream));
  }

  private async handleArtifactFetch(stream: Stream): Promise<void> {
    const request = ArtifactFetchRequestSchema.parse(await readJson(stream));
    if (!this.hasValidToken(request)) {
      await writeJson(stream, rejectedArtifactFetchResponse(request.request_type, "invalid swarm token"));
      return;
    }

    const manifest = this.artifacts.get(request.job_id);
    if (manifest == null || manifest.artifact_hash !== request.artifact_hash) {
      await writeJson(stream, rejectedArtifactFetchResponse(request.request_type, "artifact not found"));
      return;
    }

    try {
      const bundle = await this.bundleFor(manifest);
      if (request.request_type === "manifest") {
        await writeJson(stream, await artifactBundleManifestResponse(bundle));
        return;
      }
      await writeJson(stream, await readArtifactBundleChunk(bundle, request));
    } catch (error) {
      await writeJson(stream, rejectedArtifactFetchResponse(
        request.request_type,
        error instanceof Error ? error.message : "artifact fetch failed",
      ));
    }
  }

  private async bundleFor(manifest: ArtifactManifest): Promise<ArtifactBundle> {
    const existing = this.artifactBundles.get(manifest.job_id);
    if (existing != null && existing.artifact_hash === manifest.artifact_hash) {
      return existing;
    }
    const bundle = await createArtifactBundle(manifest);
    this.artifactBundles.set(manifest.job_id, bundle);
    return bundle;
  }

  private async requestControlJson(
    protocol: Parameters<typeof requestJson>[2],
    payload: unknown,
    options?: Parameters<typeof requestJson>[4],
  ): Promise<unknown> {
    const controlAddrs = this.controlAddrsByPriority();
    const failures: string[] = [];
    for (const addr of controlAddrs) {
      try {
        const response = await requestJson(this.node, addr, protocol, payload, options);
        this.activeControlAddr = addr;
        return response;
      } catch (error) {
        failures.push(`${addr.toString()}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`all control addresses failed for ${protocol}: ${failures.join("; ")}`);
  }

  private controlAddrsByPriority(): Multiaddr[] {
    const all = workerControlAddrs(this.options);
    if (this.activeControlAddr == null) {
      return all;
    }
    const active = this.activeControlAddr.toString();
    return [
      this.activeControlAddr,
      ...all.filter((addr) => addr.toString() !== active),
    ];
  }

  private async publicKey(): Promise<string> {
    const encoded = await readFile(this.options.privateKeyPath, "utf8");
    return publicKeyBase64(privateKeyFromProtobuf(Buffer.from(encoded, "base64")));
  }

  private authPayload(): { auth_token?: string } {
    const token = this.options.swarmToken ?? process.env.MARSHALL_SWARM_TOKEN;
    return token == null || token === "" ? {} : { auth_token: token };
  }

  private hasValidToken(payload: { auth_token?: string }): boolean {
    const token = this.options.swarmToken ?? process.env.MARSHALL_SWARM_TOKEN;
    return token == null || token === "" || payload.auth_token === token;
  }
}

function workerControlAddrs(options: WorkerPeerOptions): Multiaddr[] {
  const values = options.controlAddrs == null || options.controlAddrs.length === 0
    ? [options.controlAddr]
    : options.controlAddrs;
  const deduped = new Map<string, Multiaddr>();
  for (const value of values) {
    deduped.set(value.toString(), value);
  }
  return [...deduped.values()];
}

function rejectedArtifactFetchResponse(requestType: "manifest" | "chunk", reason: string): unknown {
  if (requestType === "manifest") {
    return ArtifactFetchManifestResponseSchema.parse({
      response_type: "manifest",
      accepted: false,
      reason,
    });
  }
  return ArtifactFetchChunkResponseSchema.parse({
    response_type: "chunk",
    accepted: false,
    reason,
  });
}
