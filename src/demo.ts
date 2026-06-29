import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPeer } from "./control-peer.js";
import { WorkerPeer } from "./worker-peer.js";

const tempDir = await mkdtemp(join(tmpdir(), "marshall-demo-"));

try {
  const control = await ControlPeer.create({
    privateKeyPath: join(tempDir, "control.key"),
  });
  const worker = await WorkerPeer.create({
    privateKeyPath: join(tempDir, "worker.key"),
    workerId: "mac-worker-demo-01",
    controlAddr: control.multiaddrs[0],
  });

  await worker.register();
  await worker.heartbeat("idle");
  const claim = await worker.claimTrainAdapterJob();

  if (!claim.accepted || claim.job == null) {
    throw new Error("demo worker did not receive a job");
  }

  await worker.reportJobStatus({
    job_id: claim.job.job_id,
    status: "running",
    message: "simulated MLX runner started",
  });
  await worker.publishArtifactManifest({
    job_id: claim.job.job_id,
    artifact_type: "lora_adapter",
    artifact_uri: `file://artifacts/${claim.job.job_id}/adapter.safetensors`,
    artifact_hash: "sha256:demo-adapter",
    config_hash: "sha256:demo-config",
    created_at: new Date().toISOString(),
  });
  await worker.reportJobStatus({
    job_id: claim.job.job_id,
    status: "completed",
    message: "simulated MLX runner completed",
  });

  console.log(JSON.stringify({
    controlPeerId: control.peerId,
    controlAddr: control.multiaddrs[0].toString(),
    registrations: control.state.registrations.length,
    heartbeats: control.state.heartbeats.length,
    statuses: control.state.statuses.length,
    manifests: control.state.manifests.length,
    assignedJobs: control.state.assignedJobs.size,
  }, null, 2));

  await worker.stop();
  await control.stop();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
