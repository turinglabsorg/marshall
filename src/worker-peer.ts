import type { Libp2p } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { readFile } from "node:fs/promises";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { publicKeyBase64 } from "./identity.js";
import { createMarshallNode } from "./node.js";
import { PROTOCOLS } from "./protocols.js";
import {
  AckSchema,
  ArtifactManifestSchema,
  JobClaimResponseSchema,
  WorkerRegistrationResponseSchema,
  type ArtifactManifest,
  type Backend,
  type JobClaimResponse,
  type JobType,
  type JobStatus,
  type WorkerRegistration,
} from "./schemas.js";
import { requestJson } from "./wire.js";

export interface WorkerPeerOptions {
  privateKeyPath: string;
  workerId: string;
  controlAddr: Multiaddr;
  backend?: Backend;
  supportedJobs?: JobType[];
  memoryGb?: number;
  tokensPerSecond?: number;
}

export class WorkerPeer {
  private constructor(
    readonly node: Libp2p,
    private readonly options: WorkerPeerOptions,
  ) {}

  static async create(options: WorkerPeerOptions): Promise<WorkerPeer> {
    const node = await createMarshallNode({
      privateKeyPath: options.privateKeyPath,
      listen: ["/ip4/127.0.0.1/tcp/0"],
      bootstrapAddrs: [options.controlAddr.toString()],
    });
    return new WorkerPeer(node, options);
  }

  get peerId(): string {
    return this.node.peerId.toString();
  }

  async stop(): Promise<void> {
    await this.node.stop();
  }

  async register(): Promise<WorkerRegistration> {
    const registration: WorkerRegistration = {
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
      await requestJson(this.node, this.options.controlAddr, PROTOCOLS.workerRegister, registration),
    );

    if (!response.accepted) {
      throw new Error(`worker registration rejected: ${registration.worker_id}`);
    }

    return registration;
  }

  async heartbeat(status: "idle" | "working" = "idle"): Promise<void> {
    const response = AckSchema.parse(
      await requestJson(this.node, this.options.controlAddr, PROTOCOLS.workerHeartbeat, {
        peer_id: this.peerId,
        worker_id: this.options.workerId,
        status,
        timestamp: new Date().toISOString(),
      }),
    );

    if (!response.accepted) {
      throw new Error(`heartbeat rejected: ${response.reason ?? "unknown reason"}`);
    }
  }

  async claimJob(jobType: JobType, maxTokens = 2_000): Promise<JobClaimResponse> {
    return JobClaimResponseSchema.parse(
      await requestJson(this.node, this.options.controlAddr, PROTOCOLS.jobClaim, {
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

  async reportJobStatus(status: Omit<JobStatus, "peer_id" | "worker_id">): Promise<void> {
    const response = AckSchema.parse(
      await requestJson(this.node, this.options.controlAddr, PROTOCOLS.jobStatus, {
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
    const response = AckSchema.parse(
      await requestJson(this.node, this.options.controlAddr, PROTOCOLS.artifactManifest, ArtifactManifestSchema.parse({
        peer_id: this.peerId,
        worker_id: this.options.workerId,
        ...manifest,
      })),
    );

    if (!response.accepted) {
      throw new Error(`artifact manifest rejected: ${response.reason ?? "unknown reason"}`);
    }
  }

  private async publicKey(): Promise<string> {
    const encoded = await readFile(this.options.privateKeyPath, "utf8");
    return publicKeyBase64(privateKeyFromProtobuf(Buffer.from(encoded, "base64")));
  }
}
