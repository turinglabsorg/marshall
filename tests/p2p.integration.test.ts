import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPeer } from "../src/control-peer.js";
import { WorkerPeer } from "../src/worker-peer.js";

describe("Marshall p2p substrate", () => {
  let tempDir: string;
  let control: ControlPeer | undefined;
  let worker: WorkerPeer | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-p2p-test-"));
  });

  afterEach(async () => {
    await worker?.stop();
    await control?.stop();
    await rm(tempDir, { recursive: true, force: true });
    worker = undefined;
    control = undefined;
  });

  it("registers a worker, assigns a job, receives status, and accepts an artifact manifest over libp2p", async () => {
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

    const claim = await worker.claimTrainAdapterJob(2_000);
    expect(claim.accepted).toBe(true);
    expect(claim.job?.job_type).toBe("train_adapter");

    await worker.reportJobStatus({
      job_id: claim.job!.job_id,
      status: "running",
      message: "integration runner started",
    });

    await worker.publishArtifactManifest({
      job_id: claim.job!.job_id,
      artifact_type: "lora_adapter",
      artifact_uri: `file://artifacts/${claim.job!.job_id}/adapter.safetensors`,
      artifact_hash: "sha256:test-adapter",
      config_hash: "sha256:test-config",
      created_at: new Date().toISOString(),
    });

    await worker.reportJobStatus({
      job_id: claim.job!.job_id,
      status: "completed",
      message: "integration runner completed",
    });

    expect(control.state.registrations).toHaveLength(1);
    expect(control.state.heartbeats).toHaveLength(1);
    expect(control.state.assignedJobs.get(claim.job!.job_id)).toBe("mac-worker-test-01");
    expect(control.state.statuses.map((status) => status.status)).toEqual(["running", "completed"]);
    expect(control.state.manifests).toHaveLength(1);
    expect(control.state.manifests[0]).toMatchObject({
      peer_id: worker.peerId,
      worker_id: "mac-worker-test-01",
      job_id: claim.job!.job_id,
      artifact_type: "lora_adapter",
      artifact_hash: "sha256:test-adapter",
    });
  }, 15_000);
});
