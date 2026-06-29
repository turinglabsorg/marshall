import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPeer } from "../src/control-peer.js";
import { runToyTraining } from "../src/training-runner.js";
import type { TrainingJob } from "../src/schemas.js";
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
});

async function coordinatorEvents(): Promise<Array<{ type: string; fields: Record<string, string> }>> {
  const response = await fetch(`${coordinatorUrl}/events?count=1000`);
  if (!response.ok) {
    throw new Error(`coordinator events request failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<Array<{ type: string; fields: Record<string, string> }>>;
}
