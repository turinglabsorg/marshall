import { z } from "zod";
import type {
  ArtifactManifest,
  JobClaim,
  JobStatus,
  TrainingJob,
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

export type CoordinatorEvent = z.infer<typeof EventSchema>;
export type CoordinatorJobClaimResult = z.infer<typeof JobClaimResultSchema>;

export class CoordinatorClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async initializeJobs(jobs: TrainingJob[]): Promise<void> {
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
        dataset_uri: job.dataset_shard.uri,
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

  async claimJob(jobId: string, claim: JobClaim, leaseSeconds = 300): Promise<CoordinatorJobClaimResult> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/claim`, {
      worker_id: claim.worker_id,
      peer_id: claim.peer_id,
      lease_seconds: leaseSeconds,
    }, JobClaimResultSchema);
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

  async events(count = 100): Promise<CoordinatorEvent[]> {
    const response = await fetch(`${this.baseUrl}/events?count=${count}`);
    if (!response.ok) {
      throw new Error(`coordinator GET /events failed with ${response.status}: ${await response.text()}`);
    }
    return z.array(EventSchema).parse(await response.json());
  }

  private async post<T>(path: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
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
}
