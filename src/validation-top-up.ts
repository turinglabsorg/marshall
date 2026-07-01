import type { CoordinatorArtifact, CoordinatorJob } from "./coordinator-client.js";
import { ArtifactValidationJobSchema, type ArtifactValidationJob, type ArtifactValidationPolicy } from "./schemas.js";

export interface ValidationTopUpOptions {
  artifacts: CoordinatorArtifact[];
  validationJobs: CoordinatorJob[];
  runId: string;
  roundId: string;
  jobPrefix: string;
  quorum: number;
  minMemoryGb?: number;
  policy: Required<ArtifactValidationPolicy>;
}

export function createValidationTopUpJobs(options: ValidationTopUpOptions): ArtifactValidationJob[] {
  const existing = indexValidationJobs(options.validationJobs, options.jobPrefix);
  const jobs: ArtifactValidationJob[] = [];
  const targets = options.artifacts
    .filter((artifact) => artifact.artifact_type === "adapter_evaluation")
    .filter((artifact) => artifact.verdict == null || artifact.verdict === "")
    .sort((left, right) => left.job_id.localeCompare(right.job_id));

  for (const [targetIndex, artifact] of targets.entries()) {
    const validators = new Set(artifact.verdict_validators ?? []);
    const votes = Math.max(artifact.verdict_votes ?? 0, validators.size);
    const neededVotes = Math.max(1, options.quorum - votes);
    const targetIndexState = existing.byTarget.get(artifact.job_id);
    const targetSuffix = targetIndexState?.targetSuffix ?? validationTargetSuffix(artifact.job_id, targetIndex + 1);
    let voteIndex = targetIndexState?.maxVoteIndex ?? 0;

    for (let index = 0; index < neededVotes; index += 1) {
      let jobId = "";
      do {
        voteIndex += 1;
        jobId = `${options.jobPrefix}_${targetSuffix}_vote_${String(voteIndex).padStart(3, "0")}`;
      } while (existing.jobIds.has(jobId));

      existing.jobIds.add(jobId);
      jobs.push(ArtifactValidationJobSchema.parse({
        job_id: jobId,
        run_id: options.runId,
        round_id: options.roundId,
        job_type: "validate_artifact",
        backend: "cpu",
        resource_requirements: options.minMemoryGb == null ? undefined : { min_memory_gb: options.minMemoryGb },
        target: {
          job_id: artifact.job_id,
          worker_id: artifact.worker_id,
          peer_id: artifact.peer_id,
          artifact_type: artifact.artifact_type,
          artifact_uri: `marshall-artifact://${artifact.job_id}`,
          artifact_hash: artifact.artifact_hash,
          config_hash: artifact.config_hash,
          metrics_uri: artifact.metrics_uri == null ? undefined : `marshall-artifact://${artifact.job_id}`,
        },
        policy: options.policy,
      }));
    }
  }

  return jobs;
}

function indexValidationJobs(jobs: CoordinatorJob[], jobPrefix: string) {
  const jobIds = new Set<string>();
  const byTarget = new Map<string, { maxVoteIndex: number; targetSuffix: string }>();

  for (const job of jobs) {
    jobIds.add(job.job_id);
    if (!job.job_id.startsWith(`${jobPrefix}_`)) {
      continue;
    }
    const parsed = ArtifactValidationJobSchema.safeParse(job.job_spec);
    if (!parsed.success) {
      continue;
    }
    const match = job.job_id.match(new RegExp(`^${escapeRegExp(jobPrefix)}_(.+)_vote_(\\d+)$`));
    if (match == null) {
      continue;
    }
    const targetJobId = parsed.data.target.job_id;
    const current = byTarget.get(targetJobId);
    const voteIndex = Number(match[2]);
    if (current == null || voteIndex > current.maxVoteIndex) {
      byTarget.set(targetJobId, {
        maxVoteIndex: voteIndex,
        targetSuffix: match[1],
      });
    }
  }

  return { jobIds, byTarget };
}

function validationTargetSuffix(jobId: string, fallbackIndex: number): string {
  const match = jobId.match(/_(\d{3,})$/);
  if (match != null) {
    return match[1].padStart(6, "0");
  }
  return String(fallbackIndex).padStart(6, "0");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
