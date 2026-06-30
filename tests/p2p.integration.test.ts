import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPeer } from "../src/control-peer.js";
import { createTrainingJobs } from "../src/jobs.js";
import { runToyTraining } from "../src/training-runner.js";
import { WorkerPeer } from "../src/worker-peer.js";

describe("Marshall p2p substrate", () => {
  let tempDir: string;
  let control: ControlPeer | undefined;
  let worker: WorkerPeer | undefined;
  let workers: WorkerPeer[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-p2p-test-"));
  });

  afterEach(async () => {
    await worker?.stop();
    await Promise.all(workers.map((item) => item.stop()));
    await control?.stop();
    await rm(tempDir, { recursive: true, force: true });
    worker = undefined;
    workers = [];
    control = undefined;
  });

  it("registers a worker, trains a toy model, and publishes the artifact manifest over libp2p", async () => {
    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
    });
    worker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker.key"),
      workerId: "mac-worker-test-01",
      controlAddr: control.multiaddrs[0],
      memoryGb: 64,
      tokensPerSecond: 1234,
    });

    expect(control.multiaddrs[0].toString()).toContain("/p2p/");

    const registration = await worker.register();
    expect(registration.worker_id).toBe("mac-worker-test-01");
    expect(registration.peer_id).toBe(worker.peerId);

    await worker.heartbeat("idle");

    const claim = await worker.claimToyTrainingJob(2_000);
    expect(claim.accepted).toBe(true);
    expect(claim.job?.job_type).toBe("train_toy_model");
    if (claim.job == null || claim.job.job_type !== "train_toy_model") {
      throw new Error("expected train_toy_model job");
    }
    const job = claim.job;

    await worker.reportJobStatus({
      job_id: job.job_id,
      status: "running",
      message: "toy training runner started",
    });

    const training = await runToyTraining(job, {
      outputRoot: join(tempDir, "artifacts"),
      datasetCacheRoot: join(tempDir, "dataset-cache"),
      epochs: 25,
      learningRate: 0.35,
    });

    expect(training.metrics.examples).toBe(5);
    expect(training.metrics.loss_end).toBeLessThan(training.metrics.loss_start);
    expect(training.metrics.loss_delta).toBeGreaterThan(0);
    const artifactStat = await stat(fileURLToPath(training.manifest.artifact_uri));
    expect(artifactStat.isFile()).toBe(true);

    await worker.publishArtifactManifest(training.manifest);

    await worker.reportJobStatus({
      job_id: job.job_id,
      status: "completed",
      message: "toy training runner completed",
    });

    expect(control.state.registrations).toHaveLength(1);
    expect(control.state.heartbeats).toHaveLength(1);
    expect(control.state.assignedJobs.get(job.job_id)).toBe("mac-worker-test-01");
    expect(control.state.statuses.map((status) => status.status)).toEqual(["running", "completed"]);
    expect(control.state.manifests).toHaveLength(1);
    expect(control.state.manifests[0]).toMatchObject({
      peer_id: worker.peerId,
      worker_id: "mac-worker-test-01",
      job_id: job.job_id,
      artifact_type: "toy_language_model",
      artifact_hash: training.manifest.artifact_hash,
      metrics_uri: training.manifest.metrics_uri,
    });
  }, 15_000);

  it("assigns independent jobs to four workers claiming concurrently", async () => {
    const currentControl = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      jobs: createTrainingJobs("train_toy_model", 4, {
        jobId: "job_multi_toy",
        runId: "run_multi_toy",
        roundId: "round_001",
      }),
    });
    control = currentControl;
    const workerIds = ["mac-worker-test-a", "mac-worker-test-b", "mac-worker-test-c", "mac-worker-test-d"];
    workers = await Promise.all(workerIds.map((workerId, index) =>
      WorkerPeer.create({
        privateKeyPath: join(tempDir, `worker-${index}.key`),
        workerId,
        controlAddr: currentControl.multiaddrs[0],
        memoryGb: 64,
        tokensPerSecond: 1200 + index,
      }),
    ));

    await Promise.all(workers.map((item) => item.register()));
    await Promise.all(workers.map((item) => item.heartbeat("idle")));

    const claims = await Promise.all(workers.map((item) => item.claimToyTrainingJob(2_000)));
    expect(claims.every((claim) => claim.accepted)).toBe(true);
    expect(claims.every((claim) => claim.job?.job_type === "train_toy_model")).toBe(true);
    expect(new Set(claims.map((claim) => claim.job!.job_id)).size).toBe(4);

    const trainingRuns = await Promise.all(claims.map(async (claim, index) => {
      if (claim.job == null || claim.job.job_type !== "train_toy_model") {
        throw new Error("expected train_toy_model job");
      }
      const job = claim.job;
      const currentWorker = workers[index];
      await currentWorker.reportJobStatus({
        job_id: job.job_id,
        status: "running",
        message: "toy training runner started",
      });
      const training = await runToyTraining(job, {
        outputRoot: join(tempDir, "artifacts"),
        datasetCacheRoot: join(tempDir, "dataset-cache"),
        epochs: 15,
        learningRate: 0.35,
      });
      await currentWorker.publishArtifactManifest(training.manifest);
      await currentWorker.reportJobStatus({
        job_id: job.job_id,
        status: "completed",
        message: "toy training runner completed",
      });
      return training;
    }));

    expect(trainingRuns.every((run) => run.metrics.loss_end < run.metrics.loss_start)).toBe(true);
    expect(control.state.registrations.map((registration) => registration.worker_id).sort()).toEqual(workerIds);
    expect(control.state.assignedJobs.size).toBe(4);
    expect([...control.state.assignedJobs.values()].sort()).toEqual(workerIds);
    expect(control.state.manifests).toHaveLength(4);
    expect(new Set(control.state.manifests.map((manifest) => manifest.job_id)).size).toBe(4);
    expect(control.state.statuses.filter((status) => status.status === "completed")).toHaveLength(4);
  }, 20_000);

  it("rejects workers that do not present the configured swarm token", async () => {
    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      swarmToken: "swarm-secret",
    });
    const rejectedWorker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "rejected-worker.key"),
      workerId: "mac-worker-rejected",
      controlAddr: control.multiaddrs[0],
      swarmToken: "wrong-secret",
    });
    workers.push(rejectedWorker);

    await expect(rejectedWorker.register()).rejects.toThrow("worker registration rejected");
    expect(control.state.registrations).toHaveLength(0);

    worker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "accepted-worker.key"),
      workerId: "mac-worker-accepted",
      controlAddr: control.multiaddrs[0],
      swarmToken: "swarm-secret",
    });
    const registration = await worker.register();
    expect(registration.worker_id).toBe("mac-worker-accepted");

    const claim = await worker.claimToyTrainingJob(2_000);
    expect(claim.accepted).toBe(true);
    expect(claim.job?.job_type).toBe("train_toy_model");
  }, 15_000);
});
