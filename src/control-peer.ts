import type { Libp2p, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { PROTOCOLS } from "./protocols.js";
import {
  AckSchema,
  ArtifactManifestSchema,
  JobClaimSchema,
  JobClaimResponseSchema,
  JobStatusSchema,
  WorkerHeartbeatSchema,
  WorkerRegistrationSchema,
  type Ack,
  type ArtifactManifest,
  type JobClaim,
  type JobClaimResponse,
  type JobStatus,
  type MarshallJob,
  type WorkerHeartbeat,
  type WorkerRegistration,
  type WorkerRegistrationResponse,
} from "./schemas.js";
import { CoordinatorClient } from "./coordinator-client.js";
import { createToyTrainingJob } from "./jobs.js";
import { createMarshallNode } from "./node.js";
import { readJson, writeJson } from "./wire.js";

export interface ControlPeerOptions {
  privateKeyPath: string;
  listen?: string[];
  jobs?: MarshallJob[];
  coordinatorUrl?: string;
  coordinatorToken?: string;
  swarmToken?: string;
  jobLeaseSeconds?: number;
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
    private readonly jobs: MarshallJob[],
    private readonly coordinator?: CoordinatorClient,
    private readonly swarmToken?: string,
    private readonly jobLeaseSeconds = 300,
  ) {}

  static async create(options: ControlPeerOptions): Promise<ControlPeer> {
    const node = await createMarshallNode({
      privateKeyPath: options.privateKeyPath,
      listen: options.listen ?? ["/ip4/127.0.0.1/tcp/0"],
    });
    const jobs = options.jobs ?? [defaultToyTrainingJob()];
    const coordinator = options.coordinatorUrl == null
      ? undefined
      : new CoordinatorClient(options.coordinatorUrl, { token: options.coordinatorToken ?? process.env.MARSHALL_COORDINATOR_TOKEN });
    const peer = new ControlPeer(
      node,
      jobs,
      coordinator,
      options.swarmToken ?? process.env.MARSHALL_SWARM_TOKEN,
      options.jobLeaseSeconds ?? numberEnv("MARSHALL_JOB_LEASE_SECONDS", 300),
    );
    await coordinator?.initializeJobs(jobs);
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
    const payload = WorkerRegistrationSchema.parse(await readJson(stream));
    if (!this.hasValidToken(payload)) {
      await writeJson(stream, {
        accepted: false,
        worker_id: payload.worker_id,
        peer_id: payload.peer_id,
      });
      return;
    }
    const registration = withoutAuthToken(payload);
    try {
      await this.coordinator?.registerWorker(registration);
    } catch (error) {
      await writeJson(stream, {
        accepted: false,
        worker_id: registration.worker_id,
        peer_id: registration.peer_id,
      });
      return;
    }

    this.state.registrations.push(registration);
    const response: WorkerRegistrationResponse = {
      accepted: true,
      worker_id: registration.worker_id,
      peer_id: registration.peer_id,
    };
    await writeJson(stream, response);
  }

  private async handleWorkerHeartbeat(stream: Stream): Promise<void> {
    const payload = WorkerHeartbeatSchema.parse(await readJson(stream));
    if (!this.hasValidToken(payload)) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "invalid swarm token",
      }));
      return;
    }
    const heartbeat = withoutAuthToken(payload);
    try {
      await this.coordinator?.workerHeartbeat(heartbeat);
    } catch (error) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: error instanceof Error ? error.message : "coordinator rejected heartbeat",
      }));
      return;
    }
    this.state.heartbeats.push(heartbeat);
    const response: Ack = { accepted: true };
    await writeJson(stream, AckSchema.parse(response));
  }

  private async handleJobClaim(stream: Stream): Promise<void> {
    const payload = JobClaimSchema.parse(await readJson(stream));
    if (!this.hasValidToken(payload)) {
      await writeJson(stream, JobClaimResponseSchema.parse({
        accepted: false,
        job: null,
        reason: "invalid swarm token",
      }));
      return;
    }
    const claim = withoutAuthToken(payload);
    const response = await this.claimCompatibleJob(claim);
    await writeJson(stream, JobClaimResponseSchema.parse(response));
  }

  private async claimCompatibleJob(claim: JobClaim): Promise<JobClaimResponse> {
    if (this.coordinator != null) {
      try {
        const result = await this.coordinator.requeueExpiredJobs();
        for (const jobID of result.requeued) {
          this.state.assignedJobs.delete(jobID);
        }
      } catch (error) {
        return {
          accepted: false,
          job: null,
          reason: error instanceof Error ? error.message : "coordinator rejected requeue scan",
        };
      }
    }

    let lastRejection: string | undefined;
    for (const job of this.jobs) {
      if (
        job.job_type !== claim.job_type
        || job.backend !== claim.backend
        || this.state.assignedJobs.has(job.job_id)
      ) {
        continue;
      }

      this.state.assignedJobs.set(job.job_id, claim.worker_id);
      if (this.coordinator == null) {
        return { accepted: true, job };
      }

      try {
        const coordinatorClaim = await this.coordinator.claimJob(job.job_id, {
          ...claim,
          job_type: job.job_type,
          backend: job.backend,
        }, this.jobLeaseSeconds);
        if (coordinatorClaim.accepted) {
          return { accepted: true, job };
        }
        this.state.assignedJobs.delete(job.job_id);
        lastRejection = coordinatorClaim.reason ?? "coordinator rejected job claim";
      } catch (error) {
        this.state.assignedJobs.delete(job.job_id);
        return {
          accepted: false,
          job: null,
          reason: error instanceof Error ? error.message : "coordinator rejected job claim",
        };
      }
    }

    return {
      accepted: false,
      job: null,
      reason: lastRejection ?? "no compatible job available",
    };
  }

  private async handleJobStatus(stream: Stream): Promise<void> {
    const payload = JobStatusSchema.parse(await readJson(stream));
    if (!this.hasValidToken(payload)) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "invalid swarm token",
      }));
      return;
    }
    const status = withoutAuthToken(payload);
    try {
      await this.coordinator?.updateJobStatus(status);
    } catch (error) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: error instanceof Error ? error.message : "coordinator rejected job status",
      }));
      return;
    }

    this.state.statuses.push(status);
    await writeJson(stream, AckSchema.parse({ accepted: true }));
  }

  private async handleArtifactManifest(stream: Stream): Promise<void> {
    const payload = ArtifactManifestSchema.parse(await readJson(stream));
    if (!this.hasValidToken(payload)) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "invalid swarm token",
      }));
      return;
    }
    const manifest = withoutAuthToken(payload);
    const assignedWorker = this.state.assignedJobs.get(manifest.job_id);

    if (assignedWorker !== manifest.worker_id) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "artifact producer does not match assigned worker",
      }));
      return;
    }

    try {
      await this.coordinator?.publishArtifact(manifest);
      if (manifest.artifact_type === "artifact_validation" && manifest.validation != null) {
        await this.coordinator?.recordArtifactVerdict(manifest.validation.target_job_id, {
          worker_id: manifest.validation.target_worker_id,
          verdict: manifest.validation.verdict,
          validator_id: manifest.worker_id,
          reason: manifest.validation.reason,
          created_at: manifest.created_at,
        });
      }
    } catch (error) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: error instanceof Error ? error.message : "coordinator rejected artifact manifest",
      }));
      return;
    }

    this.state.manifests.push(manifest);
    await writeJson(stream, AckSchema.parse({ accepted: true }));
  }

  private hasValidToken(payload: { auth_token?: string }): boolean {
    return this.swarmToken == null || this.swarmToken === "" || payload.auth_token === this.swarmToken;
  }
}

function defaultToyTrainingJob(): MarshallJob {
  return createToyTrainingJob();
}

function withoutAuthToken<T extends { auth_token?: string }>(payload: T): Omit<T, "auth_token"> {
  const { auth_token: _authToken, ...rest } = payload;
  return rest;
}

function numberEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid ${key}: ${value}`);
  }
  return parsed;
}
