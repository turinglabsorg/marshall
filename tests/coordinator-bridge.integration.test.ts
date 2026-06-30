import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinatorClient } from "../src/coordinator-client.js";
import { ControlPeer } from "../src/control-peer.js";
import { runArtifactValidation, runToyTraining } from "../src/training-runner.js";
import type { AdapterEvaluationJob, AdapterEvaluationMetrics, ArtifactValidationJob, TrainingJob } from "../src/schemas.js";
import { WorkerPeer } from "../src/worker-peer.js";

const coordinatorUrl = process.env.MARSHALL_COORDINATOR_URL;
const describeWithCoordinator = coordinatorUrl == null ? describe.skip : describe;

describeWithCoordinator("Marshall p2p coordinator bridge", () => {
  let tempDir: string;
  let control: ControlPeer | undefined;
  let worker: WorkerPeer | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-coordinator-bridge-test-"));
  });

  afterEach(async () => {
    await worker?.stop();
    await control?.stop();
    await rm(tempDir, { recursive: true, force: true });
    worker = undefined;
    control = undefined;
  });

  it("persists the p2p job lifecycle in the Go coordinator event log", async () => {
    const suffix = Date.now().toString(36);
    const workerId = `mac-worker-bridge-${suffix}`;
    const job: TrainingJob = {
      job_id: `job_bridge_${suffix}`,
      run_id: `run_bridge_${suffix}`,
      round_id: "round_001",
      job_type: "train_toy_model",
      backend: "cpu",
      dataset_shard: {
        id: "tiny_italian_local",
        uri: "file://examples/datasets/tiny-italian.jsonl",
        token_estimate: 2_000,
        hash: "sha256:067c5c80ae7ae08a2d33868b85e149de94878dd13c7689a64561d9dd3d0751dd",
      },
    };

    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      coordinatorUrl,
      jobs: [job],
    });
    worker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker.key"),
      workerId,
      controlAddr: control.multiaddrs[0],
    });

    await worker.register();
    const claim = await worker.claimToyTrainingJob(2_000);
    expect(claim.accepted).toBe(true);
    expect(claim.job?.job_id).toBe(job.job_id);

    await worker.reportJobStatus({
      job_id: job.job_id,
      status: "running",
      message: "coordinator bridge runner started",
    });

    const training = await runToyTraining(job, {
      outputRoot: join(tempDir, "artifacts"),
      epochs: 25,
      learningRate: 0.35,
    });

    await worker.publishArtifactManifest(training.manifest);
    await worker.reportJobStatus({
      job_id: job.job_id,
      status: "completed",
      message: "coordinator bridge runner completed",
    });

    const events = await coordinatorEvents();
    const relevantTypes = new Set(
      events
        .filter((event) => event.fields.job_id === job.job_id || event.fields.worker_id === workerId || event.fields.run_id === job.run_id)
        .map((event) => event.type),
    );

    expect(relevantTypes).toEqual(new Set([
      "run_created",
      "worker_registered",
      "job_created",
      "job_claimed",
      "job_status_updated",
      "artifact_published",
    ]));
  }, 20_000);

  it("persists evaluate_adapter job specs and artifacts in the coordinator", async () => {
    const suffix = Date.now().toString(36);
    const workerId = `mac-worker-eval-bridge-${suffix}`;
    const job: AdapterEvaluationJob = {
      job_id: `job_eval_bridge_${suffix}`,
      run_id: `run_eval_bridge_${suffix}`,
      round_id: "round_001",
      job_type: "evaluate_adapter",
      backend: "mlx",
      model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      adapter: {
        adapter_id: `job_adapter_bridge_${suffix}`,
        artifact_uri: "file://artifacts/job_adapter_bridge/adapters",
        artifact_hash: "sha256:adapter-bridge",
        config_hash: "sha256:adapter-config-bridge",
        source_job_id: `job_adapter_bridge_${suffix}`,
      },
      eval_shard: {
        id: "eval_jsonl",
        uri: "file://datasets/ag-news/eval.jsonl",
        token_estimate: 1,
        hash: "sha256:eval-bridge",
      },
      max_examples: 40,
      max_tokens: 8,
    };

    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      coordinatorUrl,
      jobs: [job],
    });
    worker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker.key"),
      workerId,
      controlAddr: control.multiaddrs[0],
      backend: "mlx",
      supportedJobs: ["evaluate_adapter"],
    });

    await worker.register();
    const claim = await worker.claimJob("evaluate_adapter", 8_000);
    expect(claim.accepted).toBe(true);
    expect(claim.job?.job_id).toBe(job.job_id);

    await worker.reportJobStatus({
      job_id: job.job_id,
      status: "running",
      message: "adapter evaluation runner started",
    });
    await worker.publishArtifactManifest({
      job_id: job.job_id,
      artifact_type: "adapter_evaluation",
      artifact_uri: `file://eval-artifacts/${job.job_id}/metrics.json`,
      artifact_hash: "sha256:eval-artifact-bridge",
      config_hash: "sha256:eval-config-bridge",
      created_at: new Date().toISOString(),
      metrics_uri: `file://eval-artifacts/${job.job_id}/metrics.json`,
    });
    await worker.reportJobStatus({
      job_id: job.job_id,
      status: "completed",
      message: "adapter evaluation runner completed",
    });

    const coordinator = new CoordinatorClient(coordinatorUrl!);
    const persistedJob = await coordinator.getJob(job.job_id);
    const persistedSpec = persistedJob.job_spec as AdapterEvaluationJob;
    expect(persistedJob.status).toBe("completed");
    expect(persistedJob.worker_id).toBe(workerId);
    expect(persistedSpec.job_type).toBe("evaluate_adapter");
    expect(persistedSpec.adapter.artifact_hash).toBe(job.adapter.artifact_hash);
    expect(persistedSpec.eval_shard.hash).toBe(job.eval_shard.hash);

    const artifact = await coordinator.getArtifact(job.job_id);
    expect(artifact.artifact_type).toBe("adapter_evaluation");
    expect(artifact.artifact_hash).toBe("sha256:eval-artifact-bridge");
    expect(artifact.metrics_uri).toBe(`file://eval-artifacts/${job.job_id}/metrics.json`);
  }, 20_000);

  it("records target worker verdicts from distributed artifact validation manifests", async () => {
    const suffix = Date.now().toString(36);
    const evalWorkerId = `mac-worker-eval-target-${suffix}`;
    const validatorWorkerId = `mac-worker-validator-${suffix}`;
    const evalMetricsPath = join(tempDir, `target-eval-${suffix}.json`);
    const evalJob: AdapterEvaluationJob = {
      job_id: `job_eval_target_${suffix}`,
      run_id: `run_validation_bridge_${suffix}`,
      round_id: "round_001",
      job_type: "evaluate_adapter",
      backend: "mlx",
      model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      adapter: {
        adapter_id: `job_adapter_target_${suffix}`,
        artifact_uri: `file://artifacts/job_adapter_target_${suffix}/adapters`,
        artifact_hash: "sha256:adapter-target",
        config_hash: "sha256:adapter-config-target",
        source_job_id: `job_adapter_target_${suffix}`,
      },
      eval_shard: {
        id: "eval_jsonl",
        uri: "file://datasets/ag-news/eval.jsonl",
        token_estimate: 1,
        hash: "sha256:eval-target",
      },
      max_examples: 40,
      max_tokens: 8,
    };
    await writeFile(evalMetricsPath, JSON.stringify(adapterEvaluationMetrics(evalJob), null, 2) + "\n", "utf8");
    const evalMetricsUri = pathToFileURL(evalMetricsPath).toString();
    const evalMetricsHash = await sha256File(evalMetricsPath);
    const validationJob: ArtifactValidationJob = {
      job_id: `job_validate_eval_${suffix}`,
      run_id: `run_validation_bridge_${suffix}`,
      round_id: "round_001",
      job_type: "validate_artifact",
      backend: "cpu",
      target: {
        job_id: evalJob.job_id,
        worker_id: evalWorkerId,
        artifact_type: "adapter_evaluation",
        artifact_uri: evalMetricsUri,
        artifact_hash: evalMetricsHash,
        config_hash: "sha256:eval-target-config",
        metrics_uri: evalMetricsUri,
      },
      policy: {
        min_accuracy: 0.5,
        max_invalid_rate: 0.1,
        min_examples: 10,
      },
    };
    const peers: WorkerPeer[] = [];

    try {
      control = await ControlPeer.create({
        privateKeyPath: join(tempDir, "control.key"),
        coordinatorUrl,
        jobs: [evalJob, validationJob],
      });
      const evalWorker = await WorkerPeer.create({
        privateKeyPath: join(tempDir, "eval-worker.key"),
        workerId: evalWorkerId,
        controlAddr: control.multiaddrs[0],
        backend: "mlx",
        supportedJobs: ["evaluate_adapter"],
      });
      const validatorWorker = await WorkerPeer.create({
        privateKeyPath: join(tempDir, "validator-worker.key"),
        workerId: validatorWorkerId,
        controlAddr: control.multiaddrs[0],
        backend: "cpu",
        supportedJobs: ["validate_artifact"],
      });
      peers.push(evalWorker, validatorWorker);

      await evalWorker.register();
      const evalClaim = await evalWorker.claimJob("evaluate_adapter", 8_000);
      expect(evalClaim.accepted).toBe(true);
      await evalWorker.publishArtifactManifest({
        job_id: evalJob.job_id,
        artifact_type: "adapter_evaluation",
        artifact_uri: validationJob.target.artifact_uri,
        artifact_hash: validationJob.target.artifact_hash,
        config_hash: validationJob.target.config_hash!,
        created_at: new Date().toISOString(),
        metrics_uri: validationJob.target.metrics_uri,
      });

      await validatorWorker.register();
      const validationClaim = await validatorWorker.claimJob("validate_artifact", 2_000);
      expect(validationClaim.accepted).toBe(true);
      const validation = await runArtifactValidation(validationJob, {
        outputRoot: join(tempDir, "validation-artifacts"),
      });
      expect(validation.metrics.verdict).toBe("accepted");
      await validatorWorker.publishArtifactManifest(validation.manifest);

      const coordinator = new CoordinatorClient(coordinatorUrl!);
      const targetArtifact = await coordinator.getArtifact(evalJob.job_id);
      expect(targetArtifact.verdict).toBe("accepted");

      const targetReputation = await coordinator.workerReputation(evalWorkerId);
      expect(targetReputation.accepted_artifacts).toBe(1);
      expect(targetReputation.status).toBe("active");
    } finally {
      await Promise.all(peers.map((item) => item.stop()));
    }
  }, 20_000);

  it("assigns unique evaluate_adapter jobs under concurrent coordinator-backed claims", async () => {
    const suffix = Date.now().toString(36);
    const jobs: AdapterEvaluationJob[] = Array.from({ length: 4 }, (_, index) => {
      const id = String(index + 1).padStart(3, "0");
      return {
        job_id: `job_eval_bridge_${suffix}_${id}`,
        run_id: `run_eval_bridge_${suffix}`,
        round_id: "round_001",
        job_type: "evaluate_adapter",
        backend: "mlx",
        model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
        adapter: {
          adapter_id: `job_adapter_bridge_${suffix}_${id}`,
          artifact_uri: `file://artifacts/job_adapter_bridge_${id}/adapters`,
          artifact_hash: `sha256:adapter-bridge-${id}`,
          config_hash: `sha256:adapter-config-bridge-${id}`,
          source_job_id: `job_adapter_bridge_${suffix}_${id}`,
        },
        eval_shard: {
          id: "eval_jsonl",
          uri: "file://datasets/ag-news/eval.jsonl",
          token_estimate: 1,
          hash: "sha256:eval-bridge",
        },
        max_examples: 40,
        max_tokens: 8,
      };
    });
    const concurrentWorkers: WorkerPeer[] = [];

    try {
      control = await ControlPeer.create({
        privateKeyPath: join(tempDir, "control.key"),
        coordinatorUrl,
        jobs,
      });
      for (let index = 0; index < 4; index += 1) {
        concurrentWorkers.push(await WorkerPeer.create({
          privateKeyPath: join(tempDir, `worker-${index}.key`),
          workerId: `mac-worker-eval-concurrent-${suffix}-${index}`,
          controlAddr: control.multiaddrs[0],
          backend: "mlx",
          supportedJobs: ["evaluate_adapter"],
        }));
      }

      await Promise.all(concurrentWorkers.map((item) => item.register()));
      const claims = await Promise.all(concurrentWorkers.map((item) => item.claimJob("evaluate_adapter", 8_000)));
      expect(claims.every((claim) => claim.accepted)).toBe(true);
      expect(new Set(claims.map((claim) => claim.job?.job_id)).size).toBe(4);

      const coordinator = new CoordinatorClient(coordinatorUrl!);
      for (const claim of claims) {
        expect(claim.job?.job_type).toBe("evaluate_adapter");
        const persisted = await coordinator.getJob(claim.job!.job_id);
        expect(persisted.status).toBe("claimed");
      }
    } finally {
      await Promise.all(concurrentWorkers.map((item) => item.stop()));
    }
  }, 20_000);
});

async function coordinatorEvents(): Promise<Array<{ type: string; fields: Record<string, string> }>> {
  const response = await fetch(`${coordinatorUrl}/events?count=1000`);
  if (!response.ok) {
    throw new Error(`coordinator events request failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<Array<{ type: string; fields: Record<string, string> }>>;
}

function adapterEvaluationMetrics(job: AdapterEvaluationJob): AdapterEvaluationMetrics {
  return {
    job_id: job.job_id,
    run_id: job.run_id,
    round_id: job.round_id,
    adapter_id: job.adapter.adapter_id,
    adapter_artifact_hash: job.adapter.artifact_hash,
    eval_shard_id: job.eval_shard.id,
    eval_shard_hash: job.eval_shard.hash,
    model: job.model,
    adapter_path: null,
    eval_file: "eval.jsonl",
    examples: 20,
    correct: 15,
    accuracy: 0.75,
    invalid: 0,
    invalid_rate: 0,
    labels: ["World", "Sports"],
    results: [
      {
        id: "example-001",
        expected_label: "World",
        predicted_label: "World",
        correct: true,
        output: "World",
      },
    ],
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}
