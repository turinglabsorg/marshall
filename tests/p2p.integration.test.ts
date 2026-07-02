import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactStoreManifestPath, sha256File, sha256Path } from "../src/artifact-transfer.js";
import { ControlPeer } from "../src/control-peer.js";
import { createTrainingJobs } from "../src/jobs.js";
import { modelArtifactUri, publishModelPackageArtifact, type OptimizedModelPackage } from "../src/model-package.js";
import { promoteModelPackageFromControl } from "../src/model-promotion.js";
import { runToyTraining } from "../src/training-runner.js";
import { WorkerPeer } from "../src/worker-peer.js";
import { TrainingArtifactManifestSchema, type AdapterEvaluationJob, type ArtifactValidationJob } from "../src/schemas.js";

describe("Marshall p2p substrate", () => {
  let tempDir: string;
  let control: ControlPeer | undefined;
  let mirrorControl: ControlPeer | undefined;
  let worker: WorkerPeer | undefined;
  let workers: WorkerPeer[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "marshall-p2p-test-"));
  });

  afterEach(async () => {
    await worker?.stop();
    await Promise.all(workers.map((item) => item.stop()));
    await control?.stop();
    await mirrorControl?.stop();
    await rm(tempDir, { recursive: true, force: true });
    worker = undefined;
    workers = [];
    control = undefined;
    mirrorControl = undefined;
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

  it("rejects claims from workers below a job memory requirement", async () => {
    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      jobs: createTrainingJobs("train_toy_model", 1, {
        jobId: "job_memory_gated",
        runId: "run_memory_gated",
        roundId: "round_001",
        resourceRequirements: {
          min_memory_gb: 32,
        },
      }),
    });
    const lowMemoryWorker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker-low-memory.key"),
      workerId: "mac-worker-low-memory",
      controlAddr: control.multiaddrs[0],
      memoryGb: 16,
      tokensPerSecond: 1000,
    });
    const highMemoryWorker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker-high-memory.key"),
      workerId: "mac-worker-high-memory",
      controlAddr: control.multiaddrs[0],
      memoryGb: 64,
      tokensPerSecond: 1000,
    });
    workers.push(lowMemoryWorker, highMemoryWorker);

    await lowMemoryWorker.register();
    await highMemoryWorker.register();

    const rejectedClaim = await lowMemoryWorker.claimToyTrainingJob(2_000);
    expect(rejectedClaim.accepted).toBe(false);
    expect(rejectedClaim.reason).toContain("below job minimum");

    const acceptedClaim = await highMemoryWorker.claimToyTrainingJob(2_000);
    expect(acceptedClaim.accepted).toBe(true);
    expect(acceptedClaim.job?.job_id).toBe("job_memory_gated");
  }, 15_000);

  it("transfers artifact payloads over libp2p and verifies stored hashes", async () => {
    const controlArtifactStore = join(tempDir, "control-artifacts");
    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      artifactStoreDir: controlArtifactStore,
      artifactChunkBytes: 16,
      artifactMaxChunkRetries: 2,
    });
    worker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker.key"),
      workerId: "mac-worker-artifact-transfer",
      controlAddr: control.multiaddrs[0],
      memoryGb: 64,
      tokensPerSecond: 1234,
    });

    await worker.register();
    const claim = await worker.claimToyTrainingJob(2_000);
    if (claim.job == null || claim.job.job_type !== "train_toy_model") {
      throw new Error("expected train_toy_model job");
    }

    const training = await runToyTraining(claim.job, {
      outputRoot: join(tempDir, "worker-artifacts"),
      datasetCacheRoot: join(tempDir, "dataset-cache"),
      epochs: 10,
      learningRate: 0.35,
    });
    await worker.publishArtifactManifest(training.manifest);

    expect(control.state.manifests).toHaveLength(1);
    const storedManifest = control.state.manifests[0];
    expect(storedManifest.artifact_uri).not.toBe(training.manifest.artifact_uri);
    expect(fileURLToPath(storedManifest.artifact_uri).startsWith(controlArtifactStore)).toBe(true);
    expect(await sha256Path(fileURLToPath(storedManifest.artifact_uri))).toBe(training.manifest.artifact_hash);

    const materializedInput = await worker.fetchArtifactFromControl(
      storedManifest.job_id,
      storedManifest.artifact_hash,
      join(tempDir, "worker-input-artifacts"),
      { chunkBytes: 16, maxChunkRetries: 2 },
    );
    expect(await sha256Path(fileURLToPath(materializedInput.artifact_uri))).toBe(storedManifest.artifact_hash);
  }, 30_000);

  it("promotes a ready model package and adapter through chunked p2p artifact fetch", async () => {
    const controlArtifactStore = join(tempDir, "control-artifacts");
    const adapterId = "adapter_ready_001";
    const adapterDir = join(tempDir, "source-adapter");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(join(adapterDir, "adapters.safetensors"), "adapter weights split into multiple chunks", "utf8");
    await writeFile(join(adapterDir, "adapter_config.json"), "{\"rank\":4}\n", "utf8");
    const adapterHash = await sha256Path(adapterDir);
    const adapterManifestPath = artifactStoreManifestPath(controlArtifactStore, adapterId);
    await mkdir(join(controlArtifactStore, adapterId), { recursive: true });
    await writeFile(adapterManifestPath, JSON.stringify({
      worker_id: "worker_train_ready",
      peer_id: "peer_train_ready",
      job_id: adapterId,
      artifact_type: "lora_adapter",
      artifact_uri: pathToFileURL(adapterDir).toString(),
      artifact_hash: adapterHash,
      config_hash: "sha256:adapter-config",
      created_at: "2026-07-01T00:00:00.000Z",
    }, null, 2) + "\n", "utf8");

    const packageDir = join(tempDir, "model-package-source");
    await mkdir(packageDir, { recursive: true });
    const modelPackage: OptimizedModelPackage = {
      type: "marshall_optimized_model_package",
      strategy: "best_adapter_by_eval_score",
      selection_policy: null,
      created_at: "2026-07-01T00:01:00.000Z",
      run_id: "run_ready_model_test",
      base_model: "mlx-community/gemma-3-1b-it-4bit",
      adapter_id: adapterId,
      adapter_uri: modelArtifactUri(adapterId),
      adapter_path: adapterDir,
      adapter_artifact_hash: adapterHash,
      eval: {
        job_id: "job_eval_ready_001",
        eval_shard_id: "instruction_terms_jsonl",
        examples: 4,
        correct: 3,
        accuracy: 0.75,
        invalid: 0,
        invalid_rate: 0,
        score: 0.75,
        metrics_path: join(packageDir, "metrics.json"),
      },
    };
    await writeFile(modelPackage.eval.metrics_path, "{\"accuracy\":0.75}\n", "utf8");
    const packagePath = join(packageDir, "model_package.json");
    await writeFile(packagePath, JSON.stringify(modelPackage, null, 2) + "\n", "utf8");
    const packageManifest = TrainingArtifactManifestSchema.parse({
      job_id: `optimized_model_${adapterId}`,
      artifact_type: "optimized_model_package",
      artifact_uri: pathToFileURL(packagePath).toString(),
      artifact_hash: await sha256File(packagePath),
      config_hash: "sha256:package-config",
      created_at: "2026-07-01T00:01:00.000Z",
      metrics_uri: pathToFileURL(modelPackage.eval.metrics_path).toString(),
    });
    await publishModelPackageArtifact({
      modelPackage,
      manifest: packageManifest,
      artifactStoreDir: controlArtifactStore,
      registryPath: join(tempDir, "model-registry", "index.json"),
    });

    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      artifactServeDirs: [controlArtifactStore],
      artifactChunkBytes: 11,
      artifactMaxChunkRetries: 2,
    });
    worker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker.key"),
      workerId: "mac-worker-model-promotion",
      controlAddr: control.multiaddrs[0],
      memoryGb: 64,
      tokensPerSecond: 1234,
    });

    const promoted = await promoteModelPackageFromControl({
      worker,
      packageJobId: packageManifest.job_id,
      packageArtifactHash: packageManifest.artifact_hash,
      outputRoot: join(tempDir, "promoted"),
      chunkBytes: 7,
      maxChunkRetries: 2,
    });

    const promotedPackage = JSON.parse(await readFile(promoted.model_package_path, "utf8"));
    expect(promotedPackage.base_model).toBe("mlx-community/gemma-3-1b-it-4bit");
    expect(promotedPackage.adapter_id).toBe(adapterId);
    expect(promotedPackage.adapter_uri).toBe(modelArtifactUri(adapterId));
    expect(promotedPackage.adapter_path).not.toBe(adapterDir);
    expect(await sha256Path(promotedPackage.adapter_path)).toBe(adapterHash);
  }, 30_000);

  it("falls back to another control peer when the first coordinator cannot serve an artifact", async () => {
    const controlArtifactStore = join(tempDir, "mirror-control-artifacts");
    const adapterId = "adapter_multi_control_001";
    const adapterDir = join(tempDir, "source-adapter-multi-control");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(join(adapterDir, "adapters.safetensors"), "adapter bytes served by the mirror coordinator", "utf8");
    await writeFile(join(adapterDir, "adapter_config.json"), "{\"rank\":2}\n", "utf8");
    const adapterHash = await sha256Path(adapterDir);
    await mkdir(join(controlArtifactStore, adapterId), { recursive: true });
    await writeFile(artifactStoreManifestPath(controlArtifactStore, adapterId), JSON.stringify({
      worker_id: "worker_train_multi_control",
      peer_id: "peer_train_multi_control",
      job_id: adapterId,
      artifact_type: "lora_adapter",
      artifact_uri: pathToFileURL(adapterDir).toString(),
      artifact_hash: adapterHash,
      config_hash: "sha256:adapter-config",
      created_at: "2026-07-02T00:00:00.000Z",
    }, null, 2) + "\n", "utf8");

    const packageDir = join(tempDir, "model-package-multi-control");
    await mkdir(packageDir, { recursive: true });
    const modelPackage: OptimizedModelPackage = {
      type: "marshall_optimized_model_package",
      strategy: "best_adapter_by_eval_score",
      selection_policy: null,
      created_at: "2026-07-02T00:01:00.000Z",
      run_id: "run_multi_control_ready_model",
      base_model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      adapter_id: adapterId,
      adapter_uri: modelArtifactUri(adapterId),
      adapter_path: adapterDir,
      adapter_artifact_hash: adapterHash,
      eval: {
        job_id: "job_eval_multi_control_001",
        eval_shard_id: "instruction_terms_jsonl",
        examples: 2,
        correct: 2,
        accuracy: 1,
        invalid: 0,
        invalid_rate: 0,
        score: 1,
        metrics_path: join(packageDir, "metrics.json"),
      },
    };
    await writeFile(modelPackage.eval.metrics_path, "{\"accuracy\":1}\n", "utf8");
    const packagePath = join(packageDir, "model_package.json");
    await writeFile(packagePath, JSON.stringify(modelPackage, null, 2) + "\n", "utf8");
    const packageManifest = TrainingArtifactManifestSchema.parse({
      job_id: `optimized_model_${adapterId}`,
      artifact_type: "optimized_model_package",
      artifact_uri: pathToFileURL(packagePath).toString(),
      artifact_hash: await sha256File(packagePath),
      config_hash: "sha256:package-config",
      created_at: "2026-07-02T00:01:00.000Z",
      metrics_uri: pathToFileURL(modelPackage.eval.metrics_path).toString(),
    });
    await publishModelPackageArtifact({
      modelPackage,
      manifest: packageManifest,
      artifactStoreDir: controlArtifactStore,
      registryPath: join(tempDir, "model-registry", "index.json"),
    });

    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "primary-control.key"),
      artifactServeDirs: [],
    });
    mirrorControl = await ControlPeer.create({
      privateKeyPath: join(tempDir, "mirror-control.key"),
      artifactServeDirs: [controlArtifactStore],
      artifactChunkBytes: 9,
      artifactMaxChunkRetries: 2,
    });
    worker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "worker.key"),
      workerId: "mac-worker-multi-control-promotion",
      controlAddr: control.multiaddrs[0],
      controlAddrs: [control.multiaddrs[0], mirrorControl.multiaddrs[0]],
      memoryGb: 64,
      tokensPerSecond: 1234,
    });

    const promoted = await promoteModelPackageFromControl({
      worker,
      packageJobId: packageManifest.job_id,
      packageArtifactHash: packageManifest.artifact_hash,
      outputRoot: join(tempDir, "promoted-multi-control"),
      chunkBytes: 5,
      maxChunkRetries: 2,
    });
    const promotedPackage = JSON.parse(await readFile(promoted.model_package_path, "utf8"));
    expect(promotedPackage.base_model).toBe("mlx-community/Qwen2.5-0.5B-Instruct-4bit");
    expect(promotedPackage.adapter_id).toBe(adapterId);
    expect(await sha256Path(promotedPackage.adapter_path)).toBe(adapterHash);
  }, 30_000);

  it("prevents workers from evaluating adapters produced by the same worker slot", async () => {
    const controlArtifactStore = join(tempDir, "control-artifacts");
    const sourceJobId = "job_dolly_15k_public_shard_001";
    const evalJob: AdapterEvaluationJob = {
      job_id: "job_eval_dolly_adapter_000001",
      run_id: "run_eval_slot_test",
      round_id: "round_001",
      job_type: "evaluate_adapter",
      backend: "mlx",
      eval_kind: "instruction_terms",
      model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
      adapter: {
        adapter_id: sourceJobId,
        artifact_uri: `marshall-artifact://${sourceJobId}`,
        artifact_hash: "sha256:adapter-slot-test",
        source_job_id: sourceJobId,
      },
      eval_shard: {
        id: "instruction_terms_jsonl",
        uri: "file://datasets/instruction_terms.jsonl",
        token_estimate: 1,
        hash: "sha256:eval-slot-test",
      },
      max_examples: 3,
      max_tokens: 80,
    };
    const manifestPath = artifactStoreManifestPath(controlArtifactStore, sourceJobId);
    await mkdir(join(controlArtifactStore, sourceJobId), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      job_id: sourceJobId,
      worker_id: "MacBookPro.homenet.telecomitalia.it-marshall-train-0001",
      peer_id: "12D3KooWProducerPeer",
      artifact_type: "lora_adapter",
      artifact_uri: "file:///tmp/marshall-test-adapter",
      artifact_hash: "sha256:adapter-slot-test",
      config_hash: "sha256:config-slot-test",
      created_at: new Date().toISOString(),
    }, null, 2) + "\n", "utf8");

    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      jobs: [evalJob],
      artifactServeDirs: [controlArtifactStore],
    });
    const sameSlotWorker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "same-slot-worker.key"),
      workerId: "MacBookPro.homenet.telecomitalia.it-marshall-eval-0001",
      controlAddr: control.multiaddrs[0],
      backend: "mlx",
      supportedJobs: ["evaluate_adapter"],
    });
    const alternateSlotWorker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "alternate-slot-worker.key"),
      workerId: "MacBookPro.homenet.telecomitalia.it-marshall-eval-0002",
      controlAddr: control.multiaddrs[0],
      backend: "mlx",
      supportedJobs: ["evaluate_adapter"],
    });
    workers.push(sameSlotWorker, alternateSlotWorker);

    await sameSlotWorker.register();
    await alternateSlotWorker.register();
    const rejectedClaim = await sameSlotWorker.claimJob("evaluate_adapter", 2_000);
    expect(rejectedClaim.accepted).toBe(false);
    expect(rejectedClaim.reason).toContain("alternate worker slots");

    const acceptedClaim = await alternateSlotWorker.claimJob("evaluate_adapter", 2_000);
    expect(acceptedClaim.accepted).toBe(true);
    expect(acceptedClaim.job?.job_id).toBe(evalJob.job_id);
  }, 15_000);

  it("prevents workers from validating artifacts produced by the same worker slot", async () => {
    const validationJob: ArtifactValidationJob = {
      job_id: "job_validate_dolly_adapter_000001_vote_001",
      run_id: "run_validation_slot_test",
      round_id: "round_001",
      job_type: "validate_artifact",
      backend: "cpu",
      target: {
        job_id: "job_eval_dolly_adapter_000001",
        worker_id: "MacBookPro.homenet.telecomitalia.it-marshall-eval-0001",
        peer_id: "12D3KooWProducerPeer",
        artifact_type: "adapter_evaluation",
        artifact_uri: "file:///tmp/marshall-test-eval-metrics.json",
        artifact_hash: "sha256:evaluation-slot-test",
        config_hash: "sha256:config-slot-test",
        metrics_uri: "file:///tmp/marshall-test-eval-metrics.json",
      },
      policy: {
        min_accuracy: 0.5,
        max_invalid_rate: 0.1,
        min_examples: 1,
        quorum: 2,
      },
    };

    control = await ControlPeer.create({
      privateKeyPath: join(tempDir, "control.key"),
      jobs: [validationJob],
    });
    const sameSlotWorker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "same-slot-validation-worker.key"),
      workerId: "MacBookPro.homenet.telecomitalia.it-marshall-validation-0001",
      controlAddr: control.multiaddrs[0],
      backend: "cpu",
      supportedJobs: ["validate_artifact"],
    });
    const alternateSlotWorker = await WorkerPeer.create({
      privateKeyPath: join(tempDir, "alternate-slot-validation-worker.key"),
      workerId: "MacBookPro.homenet.telecomitalia.it-marshall-validation-0002",
      controlAddr: control.multiaddrs[0],
      backend: "cpu",
      supportedJobs: ["validate_artifact"],
    });
    workers.push(sameSlotWorker, alternateSlotWorker);

    await sameSlotWorker.register();
    await alternateSlotWorker.register();
    const rejectedClaim = await sameSlotWorker.claimJob("validate_artifact", 2_000);
    expect(rejectedClaim.accepted).toBe(false);
    expect(rejectedClaim.reason).toContain("alternate worker slots");

    const acceptedClaim = await alternateSlotWorker.claimJob("validate_artifact", 2_000);
    expect(acceptedClaim.accepted).toBe(true);
    expect(acceptedClaim.job?.job_id).toBe(validationJob.job_id);
  }, 15_000);

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
