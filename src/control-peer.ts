import type { Connection, DialTarget, Libp2p, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { readFile } from "node:fs/promises";
import {
  artifactBundleManifestResponse,
  artifactStoreManifestPath,
  createArtifactBundle,
  readArtifactBundleChunk,
  storeFetchedArtifact,
  type ArtifactBundle,
} from "./artifact-transfer.js";
import { PROTOCOLS } from "./protocols.js";
import {
  AckSchema,
  ArtifactFetchChunkResponseSchema,
  ArtifactFetchManifestResponseSchema,
  ArtifactFetchRequestSchema,
  ArtifactManifestSchema,
  JobClaimSchema,
  JobClaimResponseSchema,
  JobStatusSchema,
  MarshallJobSchema,
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
import { readJson, requestJson, writeJson } from "./wire.js";

export interface ControlPeerOptions {
  privateKeyPath: string;
  listen?: string[];
  jobs?: MarshallJob[];
  coordinatorUrl?: string;
  coordinatorToken?: string;
  swarmToken?: string;
  jobLeaseSeconds?: number;
  artifactStoreDir?: string;
  artifactServeDirs?: string[];
  artifactChunkBytes?: number;
  artifactMaxChunkRetries?: number;
  coordinatorJobSource?: boolean;
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
  private readonly servedArtifactBundles = new Map<string, ArtifactBundle>();

  private constructor(
    readonly node: Libp2p,
    private readonly jobs: MarshallJob[],
    private readonly coordinator?: CoordinatorClient,
    private readonly swarmToken?: string,
    private readonly jobLeaseSeconds = 300,
    private readonly artifactStoreDir?: string,
    private readonly artifactServeDirs: string[] = [],
    private readonly artifactChunkBytes?: number,
    private readonly artifactMaxChunkRetries?: number,
    private readonly coordinatorJobSource = false,
  ) {}

  static async create(options: ControlPeerOptions): Promise<ControlPeer> {
    const node = await createMarshallNode({
      privateKeyPath: options.privateKeyPath,
      listen: options.listen ?? ["/ip4/127.0.0.1/tcp/0"],
    });
    const jobs = options.coordinatorJobSource ? [] : options.jobs ?? [defaultToyTrainingJob()];
    const coordinator = options.coordinatorUrl == null
      ? undefined
      : new CoordinatorClient(options.coordinatorUrl, { token: options.coordinatorToken ?? process.env.MARSHALL_COORDINATOR_TOKEN });
    const artifactStoreDir = options.artifactStoreDir ?? process.env.MARSHALL_ARTIFACT_STORE_DIR;
    const configuredServeDirs = options.artifactServeDirs ?? splitListEnv("MARSHALL_ARTIFACT_SERVE_DIRS");
    const artifactServeDirs = uniqueStrings([
      ...configuredServeDirs,
      ...(artifactStoreDir == null || artifactStoreDir === "" ? [] : [artifactStoreDir]),
    ]);
    const peer = new ControlPeer(
      node,
      jobs,
      coordinator,
      options.swarmToken ?? process.env.MARSHALL_SWARM_TOKEN,
      options.jobLeaseSeconds ?? numberEnv("MARSHALL_JOB_LEASE_SECONDS", 300),
      artifactStoreDir,
      artifactServeDirs,
      options.artifactChunkBytes ?? numberEnv("MARSHALL_ARTIFACT_CHUNK_BYTES", 1024 * 1024),
      options.artifactMaxChunkRetries ?? numberEnv("MARSHALL_ARTIFACT_CHUNK_RETRIES", 3),
      options.coordinatorJobSource ?? booleanEnv("MARSHALL_COORDINATOR_JOBS", false),
    );
    if (!peer.coordinatorJobSource) {
      await coordinator?.initializeJobs(jobs);
    }
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
    await this.node.handle(PROTOCOLS.artifactManifest, (stream, connection) => this.handleArtifactManifest(stream, connection));
    await this.node.handle(PROTOCOLS.artifactFetch, (stream) => this.handleArtifactFetch(stream));
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
    let response: JobClaimResponse;
    try {
      response = await this.claimCompatibleJob(claim);
    } catch (error) {
      response = {
        accepted: false,
        job: null,
        reason: error instanceof Error ? error.message : "job claim failed",
      };
    }
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
    const jobs = await this.candidateJobs();
    for (const job of jobs) {
      if (
        job.job_type !== claim.job_type
        || job.backend !== claim.backend
        || this.state.assignedJobs.has(job.job_id)
      ) {
        continue;
      }
      const participationError = await this.participationError(job, claim);
      if (participationError != null) {
        lastRejection = participationError;
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

  private async candidateJobs(): Promise<MarshallJob[]> {
    if (!this.coordinatorJobSource) {
      return this.jobs;
    }
    if (this.coordinator == null) {
      throw new Error("coordinator job source requires a coordinator URL");
    }
    const jobs = await this.coordinator.jobs();
    const claimable: MarshallJob[] = [];
    for (const job of jobs) {
      if (job.status != null && job.status !== "" && job.status !== "queued") {
        continue;
      }
      const parsed = MarshallJobSchema.safeParse(job.job_spec);
      if (parsed.success) {
        claimable.push(parsed.data);
      }
    }
    return claimable;
  }

  private async participationError(job: MarshallJob, claim: JobClaim): Promise<string | undefined> {
    const resourceError = this.resourceParticipationError(job, claim);
    if (resourceError != null) {
      return resourceError;
    }
    if (job.job_type !== "evaluate_adapter") {
      return undefined;
    }
    const sourceJobID = job.adapter.source_job_id;
    if (sourceJobID == null || sourceJobID === "") {
      return "evaluation job has no adapter source job";
    }

    const producer = await this.artifactProducer(sourceJobID);
    if (producer == null) {
      return `adapter producer unavailable for ${sourceJobID}`;
    }
    if (producer.worker_id === claim.worker_id) {
      return "adapter producer cannot evaluate its own artifact";
    }
    if (producer.peer_id !== "" && producer.peer_id === claim.peer_id) {
      return "adapter producer peer cannot evaluate its own artifact";
    }
    if (workerAlternationKey(producer.worker_id) === workerAlternationKey(claim.worker_id)) {
      return "adapter evaluation must alternate worker slots";
    }
    return undefined;
  }

  private resourceParticipationError(job: MarshallJob, claim: JobClaim): string | undefined {
    const minMemoryGb = job.resource_requirements?.min_memory_gb;
    if (minMemoryGb == null) {
      return undefined;
    }
    const registration = this.latestRegistration(claim.worker_id);
    if (registration == null) {
      return "worker registration unavailable for memory-gated job";
    }
    if (registration.memory_gb < minMemoryGb) {
      return `worker memory ${registration.memory_gb}GB below job minimum ${minMemoryGb}GB`;
    }
    return undefined;
  }

  private latestRegistration(workerID: string): WorkerRegistration | undefined {
    for (let index = this.state.registrations.length - 1; index >= 0; index -= 1) {
      const registration = this.state.registrations[index];
      if (registration.worker_id === workerID) {
        return registration;
      }
    }
    return undefined;
  }

  private async artifactProducer(jobID: string): Promise<{ worker_id: string; peer_id: string } | undefined> {
    for (const serveDir of this.artifactServeDirs) {
      try {
        const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(artifactStoreManifestPath(serveDir, jobID), "utf8")));
        return {
          worker_id: manifest.worker_id,
          peer_id: manifest.peer_id,
        };
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        throw error;
      }
    }
    if (this.coordinator == null) {
      return undefined;
    }
    let artifact: ArtifactManifest | { worker_id: string; peer_id: string };
    try {
      artifact = await this.coordinator.getArtifact(jobID);
    } catch (error) {
      if (isCoordinatorMissing(error)) {
        return undefined;
      }
      throw error;
    }
    return {
      worker_id: artifact.worker_id,
      peer_id: artifact.peer_id,
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

  private async handleArtifactManifest(stream: Stream, connection: Connection): Promise<void> {
    const payload = ArtifactManifestSchema.parse(await readJson(stream));
    if (!this.hasValidToken(payload)) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "invalid swarm token",
      }));
      return;
    }
    const manifest = withoutAuthToken(payload);
    let assignment: { workerID: string; peerID?: string } | undefined;
    try {
      assignment = await this.assignedJobProducer(manifest.job_id);
    } catch (error) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: error instanceof Error ? error.message : "coordinator assignment lookup failed",
      }));
      return;
    }

    if (assignment?.workerID !== manifest.worker_id) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "artifact producer does not match assigned worker",
      }));
      return;
    }
    if (assignment.peerID != null && assignment.peerID !== "" && assignment.peerID !== manifest.peer_id) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: "artifact producer peer does not match assigned peer",
      }));
      return;
    }

    let storedManifest = manifest;
    try {
      storedManifest = await this.fetchArtifactPayload(manifest, connection.remotePeer);
      await this.coordinator?.publishArtifact(storedManifest);
      if (storedManifest.artifact_type === "artifact_validation" && storedManifest.validation != null) {
        await this.coordinator?.recordArtifactVerdict(storedManifest.validation.target_job_id, {
          worker_id: storedManifest.validation.target_worker_id,
          verdict: storedManifest.validation.verdict,
          validator_id: storedManifest.worker_id,
          reason: storedManifest.validation.reason,
          created_at: storedManifest.created_at,
          quorum: storedManifest.validation.quorum,
        });
      }
    } catch (error) {
      await writeJson(stream, AckSchema.parse({
        accepted: false,
        reason: error instanceof Error ? error.message : "coordinator rejected artifact manifest",
      }));
      return;
    }

    this.state.manifests.push(storedManifest);
    await writeJson(stream, AckSchema.parse({ accepted: true }));
  }

  private async assignedJobProducer(jobID: string): Promise<{ workerID: string; peerID?: string } | undefined> {
    const localWorkerID = this.state.assignedJobs.get(jobID);
    if (localWorkerID != null) {
      return { workerID: localWorkerID };
    }
    if (this.coordinator == null) {
      return undefined;
    }

    const job = await this.coordinator.getJob(jobID);
    if (job.worker_id == null || job.worker_id === "") {
      return undefined;
    }
    this.state.assignedJobs.set(jobID, job.worker_id);
    return {
      workerID: job.worker_id,
      peerID: job.peer_id,
    };
  }

  private async fetchArtifactPayload(manifest: ArtifactManifest, worker: DialTarget): Promise<ArtifactManifest> {
    if (this.artifactStoreDir == null || this.artifactStoreDir === "") {
      return manifest;
    }

    const bundle = ArtifactFetchManifestResponseSchema.parse(await requestJson(
      this.node,
      worker,
      PROTOCOLS.artifactFetch,
      {
        ...this.authPayload(),
        request_type: "manifest",
        job_id: manifest.job_id,
        artifact_hash: manifest.artifact_hash,
      },
      { timeoutMs: 30_000 },
    ));

    return storeFetchedArtifact({
      manifest,
      bundle,
      outputRoot: this.artifactStoreDir,
      chunkBytes: this.artifactChunkBytes,
      maxChunkRetries: this.artifactMaxChunkRetries,
      fetchChunk: async (request) => ArtifactFetchChunkResponseSchema.parse(await requestJson(
        this.node,
        worker,
        PROTOCOLS.artifactFetch,
        {
          ...this.authPayload(),
          ...request,
        },
        { timeoutMs: 30_000 },
      )),
    });
  }

  private async handleArtifactFetch(stream: Stream): Promise<void> {
    const request = ArtifactFetchRequestSchema.parse(await readJson(stream));
    if (!this.hasValidToken(request)) {
      await writeJson(stream, rejectedArtifactFetchResponse(request.request_type, "invalid swarm token"));
      return;
    }

    try {
      const bundle = await this.storedArtifactBundle(request.job_id, request.artifact_hash);
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

  private async storedArtifactBundle(jobID: string, artifactHash: string): Promise<ArtifactBundle> {
    const cacheKey = `${jobID}:${artifactHash}`;
    const existing = this.servedArtifactBundles.get(cacheKey);
    if (existing != null) {
      return existing;
    }

    for (const serveDir of this.artifactServeDirs) {
      const manifestPath = artifactStoreManifestPath(serveDir, jobID);
      try {
        const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
        if (manifest.artifact_hash !== artifactHash) {
          continue;
        }
        const bundle = await createArtifactBundle(manifest);
        this.servedArtifactBundles.set(cacheKey, bundle);
        return bundle;
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("artifact is not available from this control peer");
  }

  private hasValidToken(payload: { auth_token?: string }): boolean {
    return this.swarmToken == null || this.swarmToken === "" || payload.auth_token === this.swarmToken;
  }

  private authPayload(): { auth_token?: string } {
    return this.swarmToken == null || this.swarmToken === "" ? {} : { auth_token: this.swarmToken };
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

function booleanEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value == null || value === "") {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new Error(`invalid ${key}: ${value}`);
}

function splitListEnv(key: string): string[] {
  const value = process.env[key];
  if (value == null || value === "") {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function workerAlternationKey(workerID: string): string {
  const match = workerID.match(/^(.*?)-marshall-[^-]+-(\d+)$/);
  if (match != null) {
    return `${match[1]}:${Number(match[2])}`;
  }
  return workerID;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isCoordinatorMissing(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("failed with 404")
    || error.message.includes("artifact not found")
  );
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
