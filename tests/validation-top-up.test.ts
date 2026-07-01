import { describe, expect, it } from "vitest";
import { createValidationTopUpJobs } from "../src/validation-top-up.js";
import type { CoordinatorArtifact, CoordinatorJob } from "../src/coordinator-client.js";

describe("validation top-up jobs", () => {
  it("creates the next vote job for pending artifacts below quorum", () => {
    const jobs = createValidationTopUpJobs({
      artifacts: [{
        ...evaluationArtifact("job_eval_dolly_000001", "worker-eval-0001"),
        verdict_votes: 1,
        verdict_validators: ["validator-0002"],
      }],
      validationJobs: [
        validationJob("job_validate_dolly_000001_vote_001", "job_eval_dolly_000001"),
        validationJob("job_validate_dolly_000001_vote_002", "job_eval_dolly_000001"),
      ],
      runId: "run_validation",
      roundId: "round_001",
      jobPrefix: "job_validate_dolly",
      quorum: 2,
      policy: validationPolicy(),
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].job_id).toBe("job_validate_dolly_000001_vote_003");
    expect(jobs[0].target.job_id).toBe("job_eval_dolly_000001");
    expect(jobs[0].policy?.quorum).toBe(2);
  });

  it("adds a tie-break vote when validators disagree and no verdict is finalized", () => {
    const jobs = createValidationTopUpJobs({
      artifacts: [{
        ...evaluationArtifact("job_eval_dolly_000002", "worker-eval-0002"),
        verdict_votes: 2,
        verdict_validators: ["validator-0001", "validator-0003"],
      }],
      validationJobs: [
        validationJob("job_validate_dolly_000002_vote_001", "job_eval_dolly_000002"),
        validationJob("job_validate_dolly_000002_vote_002", "job_eval_dolly_000002"),
      ],
      runId: "run_validation",
      roundId: "round_001",
      jobPrefix: "job_validate_dolly",
      quorum: 2,
      policy: validationPolicy(),
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].job_id).toBe("job_validate_dolly_000002_vote_003");
  });

  it("skips artifacts that already have finalized verdicts", () => {
    const jobs = createValidationTopUpJobs({
      artifacts: [{
        ...evaluationArtifact("job_eval_dolly_000003", "worker-eval-0003"),
        verdict: "accepted",
        verdict_status: "finalized",
        verdict_votes: 2,
        verdict_validators: ["validator-0001", "validator-0002"],
      }],
      validationJobs: [],
      runId: "run_validation",
      roundId: "round_001",
      jobPrefix: "job_validate_dolly",
      quorum: 2,
      policy: validationPolicy(),
    });

    expect(jobs).toHaveLength(0);
  });
});

function evaluationArtifact(jobId: string, workerId: string): CoordinatorArtifact {
  return {
    job_id: jobId,
    worker_id: workerId,
    peer_id: `${workerId}-peer`,
    artifact_type: "adapter_evaluation",
    artifact_uri: `file:///tmp/${jobId}/metrics.json`,
    artifact_hash: `sha256:${jobId}`,
    config_hash: `sha256:config-${jobId}`,
    metrics_uri: `file:///tmp/${jobId}/metrics.json`,
    created_at: "2026-07-01T00:00:00.000Z",
  };
}

function validationJob(jobId: string, targetJobId: string): CoordinatorJob {
  return {
    job_id: jobId,
    run_id: "run_validation",
    job_type: "validate_artifact",
    backend: "cpu",
    dataset_uri: "",
    status: "completed",
    job_spec: {
      job_id: jobId,
      run_id: "run_validation",
      round_id: "round_001",
      job_type: "validate_artifact",
      backend: "cpu",
      target: {
        job_id: targetJobId,
        worker_id: "worker-eval-0001",
        peer_id: "worker-eval-0001-peer",
        artifact_type: "adapter_evaluation",
        artifact_uri: `marshall-artifact://${targetJobId}`,
        artifact_hash: `sha256:${targetJobId}`,
        config_hash: `sha256:config-${targetJobId}`,
        metrics_uri: `marshall-artifact://${targetJobId}`,
      },
      policy: validationPolicy(),
    },
  };
}

function validationPolicy() {
  return {
    min_accuracy: 0.3,
    max_invalid_rate: 0.2,
    min_examples: 1,
    quorum: 2,
  };
}
