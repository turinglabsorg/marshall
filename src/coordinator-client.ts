import { z } from "zod";
import type {
  ArtifactManifest,
  JobClaim,
  JobStatus,
  MarshallJob,
  WorkerHeartbeat,
  WorkerRegistration,
} from "./schemas.js";

const EventSchema = z.object({
  id: z.string(),
  type: z.string(),
  fields: z.record(z.string(), z.string()),
});

const JobClaimResultSchema = z.object({
  accepted: z.boolean(),
  job_id: z.string(),
  worker_id: z.string().optional(),
  reason: z.string().optional(),
  event_id: z.string().optional(),
});

const CoordinatorJobSchema = z.object({
  job_id: z.string(),
  run_id: z.string(),
  job_type: z.string(),
  backend: z.string(),
  dataset_uri: z.string(),
  status: z.string().optional(),
  worker_id: z.string().optional(),
  peer_id: z.string().optional(),
  job_spec: z.unknown().optional(),
  created_at: z.string().optional(),
});

const CoordinatorArtifactSchema = z.object({
  job_id: z.string(),
  worker_id: z.string(),
  peer_id: z.string(),
  artifact_type: z.string(),
  artifact_uri: z.string(),
  artifact_hash: z.string(),
  config_hash: z.string(),
  metrics_uri: z.string().optional(),
  created_at: z.string().optional(),
});

const RequeueResultSchema = z.object({
  requeued: z.array(z.string()),
});

export type CoordinatorEvent = z.infer<typeof EventSchema>;
export type CoordinatorJobClaimResult = z.infer<typeof JobClaimResultSchema>;
export type CoordinatorJob = z.infer<typeof CoordinatorJobSchema>;
export type CoordinatorArtifact = z.infer<typeof CoordinatorArtifactSchema>;
export type CoordinatorRequeueResult = z.infer<typeof RequeueResultSchema>;

export interface CoordinatorClientOptions {
  token?: string;
}

export class CoordinatorClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(baseUrl: string, options: CoordinatorClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = options.token ?? process.env.MARSHALL_COORDINATOR_TOKEN;
  }

  async initializeJobs(jobs: MarshallJob[]): Promise<void> {
    const runIds = new Set<string>();

    for (const job of jobs) {
      if (!runIds.has(job.run_id)) {
        await this.post("/runs", {
          run_id: job.run_id,
          objective: `Marshall run ${job.run_id}`,
        }, EventSchema);
        runIds.add(job.run_id);
      }

      await this.post("/jobs", {
        job_id: job.job_id,
        run_id: job.run_id,
        job_type: job.job_type,
        backend: job.backend,
        dataset_uri: job.job_type === "evaluate_adapter" ? job.eval_shard.uri : job.dataset_shard.uri,
        job_spec: job,
      }, EventSchema);
    }
  }

  async registerWorker(registration: WorkerRegistration): Promise<void> {
    await this.post("/workers", {
      worker_id: registration.worker_id,
      peer_id: registration.peer_id,
      backend: registration.backend,
      device_family: registration.device_family,
      memory_gb: registration.memory_gb,
      supported_jobs: registration.supported_jobs,
    }, EventSchema);
  }

  async workerHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    await this.post(`/workers/${encodeURIComponent(heartbeat.worker_id)}/heartbeat`, {
      worker_id: heartbeat.worker_id,
      peer_id: heartbeat.peer_id,
      status: heartbeat.status,
      job_id: heartbeat.job_id,
      timestamp: heartbeat.timestamp,
      lease_seconds: heartbeat.lease_seconds,
    }, EventSchema);
  }

  async claimJob(jobId: string, claim: JobClaim, leaseSeconds = 300): Promise<CoordinatorJobClaimResult> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/claim`, {
      worker_id: claim.worker_id,
      peer_id: claim.peer_id,
      lease_seconds: leaseSeconds,
    }, JobClaimResultSchema);
  }

  async requeueExpiredJobs(): Promise<CoordinatorRequeueResult> {
    return this.post("/jobs/requeue-expired", {}, RequeueResultSchema);
  }

  async updateJobStatus(status: JobStatus): Promise<void> {
    await this.post(`/jobs/${encodeURIComponent(status.job_id)}/status`, {
      worker_id: status.worker_id,
      status: status.status,
      message: status.message,
    }, EventSchema);
  }

  async publishArtifact(manifest: ArtifactManifest): Promise<void> {
    await this.post("/artifacts", {
      job_id: manifest.job_id,
      worker_id: manifest.worker_id,
      peer_id: manifest.peer_id,
      artifact_type: manifest.artifact_type,
      artifact_uri: manifest.artifact_uri,
      artifact_hash: manifest.artifact_hash,
      config_hash: manifest.config_hash,
      metrics_uri: manifest.metrics_uri,
      created_at: manifest.created_at,
    }, EventSchema);
  }

  async getJob(jobId: string): Promise<CoordinatorJob> {
    return this.get(`/jobs/${encodeURIComponent(jobId)}`, CoordinatorJobSchema);
  }

  async getArtifact(jobId: string): Promise<CoordinatorArtifact> {
    return this.get(`/artifacts/${encodeURIComponent(jobId)}`, CoordinatorArtifactSchema);
  }

  async events(count = 100): Promise<CoordinatorEvent[]> {
    return this.get(`/events?count=${count}`, z.array(EventSchema));
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    const body = await response.text();
    const json = body.length > 0 ? JSON.parse(body) : null;

    if (!response.ok) {
      const message = typeof json?.error === "string" ? json.error : body;
      throw new Error(`coordinator GET ${path} failed with ${response.status}: ${message}`);
    }

    return schema.parse(json);
  }

  private async post<T>(path: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
      }),
      body: JSON.stringify(payload),
    });

    const body = await response.text();
    const json = body.length > 0 ? JSON.parse(body) : null;

    if (!response.ok) {
      const message = typeof json?.error === "string" ? json.error : body;
      throw new Error(`coordinator POST ${path} failed with ${response.status}: ${message}`);
    }

    return schema.parse(json);
  }

  private headers(values: Record<string, string> = {}): Record<string, string> {
    if (this.token == null || this.token === "") {
      return values;
    }
    return {
      ...values,
      authorization: `Bearer ${this.token}`,
    };
  }
}
