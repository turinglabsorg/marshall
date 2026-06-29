import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPeer } from "./control-peer.js";
import { runToyTraining } from "./training-runner.js";
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
  const claim = await worker.claimToyTrainingJob();

  if (!claim.accepted || claim.job == null) {
    throw new Error("demo worker did not receive a job");
  }

  await worker.reportJobStatus({
    job_id: claim.job.job_id,
    status: "running",
    message: "toy training runner started",
  });

  const training = await runToyTraining(claim.job, {
    outputRoot: join(tempDir, "artifacts"),
    epochs: 25,
    learningRate: 0.35,
  });

  await worker.publishArtifactManifest(training.manifest);
  await worker.reportJobStatus({
    job_id: claim.job.job_id,
    status: "completed",
    message: `toy training completed with loss ${training.metrics.loss_end.toFixed(4)}`,
  });

  console.log(JSON.stringify({
    controlPeerId: control.peerId,
    controlAddr: control.multiaddrs[0].toString(),
    jobType: claim.job.job_type,
    examples: training.metrics.examples,
    tokens: training.metrics.tokens,
    lossStart: training.metrics.loss_start,
    lossEnd: training.metrics.loss_end,
    lossDelta: training.metrics.loss_delta,
    artifactHash: training.manifest.artifact_hash,
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
