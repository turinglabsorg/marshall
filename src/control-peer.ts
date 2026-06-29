import type { Libp2p, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { PROTOCOLS } from "./protocols.js";
import {
  AckSchema,
  ArtifactManifestSchema,
  JobClaimSchema,
  JobClaimResponseSchema,
  JobStatusSchema,
  TrainingJobSchema,
  WorkerHeartbeatSchema,
  WorkerRegistrationSchema,
  type Ack,
  type ArtifactManifest,
  type JobClaimResponse,
  type JobStatus,
  type TrainingJob,
  type WorkerHeartbeat,
  type WorkerRegistration,
  type WorkerRegistrationResponse,
} from "./schemas.js";
import { createMarshallNode } from "./node.js";
import { readJson, writeJson } from "./wire.js";

export interface ControlPeerOptions {
  privateKeyPath: string;
  jobs?: TrainingJob[];
}

export interface ControlPeerState {
  registrations: WorkerRegistration[];
  heartbeats: WorkerHeartbeat[];
  statuses: JobStatus[];
  manifests: ArtifactManifest[];
  assignedJobs: Map<string, string>;
}

export class ControlPeer {
  readonly state: ControlPeerState = {
    registrations: [],
    heartbeats: [],
    statuses: [],
    manifests: [],
    assignedJobs: new Map(),
  };

  private constructor(
    readonly node: Libp2p,
    private readonly jobs: TrainingJob[],
  ) {}

  static async create(options: ControlPeerOptions): Promise<ControlPeer> {
    const node = await createMarshallNode({
      privateKeyPath: options.privateKeyPath,
      listen: ["/ip4/127.0.0.1/tcp/0"],
    });
    const peer = new ControlPeer(node, options.jobs ?? [defaultToyTrainingJob()]);
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
    await this.node.handle(PROTOCOLS.workerRegister, (stream) => this.handleWorkerRegister(stream));
    await this.node.handle(PROTOCOLS.workerHeartbeat, (stream) => this.handleWorkerHeartbeat(stream));
    await this.node.handle(PROTOCOLS.jobClaim, (stream) => this.handleJobClaim(stream));
    await this.node.handle(PROTOCOLS.jobStatus, (stream) => this.handleJobStatus(stream));
    await this.node.handle(PROTOCOLS.artifactManifest, (stream) => this.handleArtifactManifest(stream));
  }

  private async handleWorkerRegister(stream: Stream): Promise<void> {
    const registration = WorkerRegistrationSchema.parse(await readJson(stream));
    this.state.registrations.push(registration);
    const response: WorkerRegistrationResponse = {
      accepted: true,
      worker_id: registration.worker_id,
      peer_id: registration.peer_id,
    };
    await writeJson(stream, response);
  }

  private async handleWorkerHeartbeat(stream: Stream): Promise<void> {
    const heartbeat = WorkerHeartbeatSchema.parse(await readJson(stream));
    this.state.heartbeats.push(heartbeat);
    const response: Ack = { accepted: true };
    await writeJson(stream, AckSchema.parse(response));
  }

  private async handleJobClaim(stream: Stream): Promise<void> {
    const claim = JobClaimSchema.parse(await readJson(stream));
    const job = this.jobs.find((candidate) => candidate.job_type === claim.job_type && candidate.backend === claim.backend);

    const response: JobClaimResponse = job
      ? { accepted: true, job }
      : { accepted: false, job: null, reason: "no compatible job available" };

    if (job) {
      this.state.assignedJobs.set(job.job_id, claim.worker_id);
    }

    await writeJson(stream, JobClaimResponseSchema.parse(response));
  }

  private async handleJobStatus(stream: Stream): Promise<void> {
    const status = JobStatusSchema.parse(await readJson(stream));
    this.state.statuses.push(status);
    await writeJson(stream, AckSchema.parse({ accepted: true }));
  }

  private async handleArtifactManifest(stream: Stream): Promise<void> {
    const manifest = ArtifactManifestSchema.parse(await readJson(stream));
    const assignedWorker = this.state.assignedJobs.get(manifest.job_id);

    if (assignedWorker !== manifest.worker_id) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "artifact producer does not match assigned worker",
      }));
      return;
    }

    this.state.manifests.push(manifest);
    await writeJson(stream, AckSchema.parse({ accepted: true }));
  }
}

function defaultToyTrainingJob(): TrainingJob {
  return TrainingJobSchema.parse({
    job_id: "job_toy_001",
    run_id: "run_toy_001",
    round_id: "round_001",
    job_type: "train_toy_model",
    backend: "cpu",
    dataset_shard: {
      id: "tiny_italian_local",
      uri: "file://examples/datasets/tiny-italian.jsonl",
      token_estimate: 2_000,
      hash: "sha256:067c5c80ae7ae08a2d33868b85e149de94878dd13c7689a64561d9dd3d0751dd",
    },
  });
}
