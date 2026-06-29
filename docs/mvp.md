# Marshall MVP

## Objective

Run a complete asynchronous adapter-training loop on 3 to 5 machines through a libp2p network.

The MVP must prove that Marshall can coordinate useful AI work across imperfect consumer hardware, validate outputs, merge accepted contributions, and continue into the next round.

## Scope

Included:

- one FastAPI coordinator for admin/debug APIs;
- one libp2p control peer;
- bootstrap/rendezvous config;
- relay support for NAT-constrained workers;
- libp2p worker registration;
- libp2p job claim/status/artifact-manifest protocols;
- SQLite metadata storage;
- local filesystem artifact storage;
- one MLX worker backend;
- one model family;
- one Italian JSONL dataset;
- one job type: `TrainAdapterJob`;
- one artifact validator;
- one adapter merge script;
- one evaluation script;
- one local dashboard or CLI status view.

Excluded:

- payments;
- token incentives;
- multi-coordinator operation;
- CUDA backend;
- production dashboard;
- full-model training.

## Current Smoke Training Path

Before the MLX LoRA backend is wired in, the prototype includes a deliberately tiny local training path:

- job type: `train_toy_model`;
- backend: `cpu`;
- dataset: `examples/datasets/tiny-italian.jsonl`;
- trainer: `training/tiny_char_lm.py`;
- output artifact type: `toy_language_model`.

This path is only for runtime validation of the p2p worker lifecycle, dataset ingestion, training execution, metric emission, and artifact manifest publication.

For Apple Silicon runtime validation, `training/mlx_linear_smoke.py` runs a tiny MLX gradient-descent job and requires `Device(gpu, 0)`.
The same smoke path is also exposed as the p2p job type `train_mlx_smoke`, with backend `mlx` and artifact type `mlx_smoke_result`.

## Done Criteria

The MVP is done when:

- workers have persistent libp2p peer identities;
- workers discover the control peer through bootstrap config or local mDNS;
- workers register automatically over libp2p;
- workers report hardware capabilities;
- the coordinator creates a run and round;
- dataset shards become train jobs;
- workers claim jobs through libp2p;
- workers train LoRA adapters with MLX;
- adapters and logs produce artifact manifests;
- artifact manifests are published through libp2p;
- validation accepts or rejects artifacts;
- accepted adapters merge;
- the merged adapter evaluates;
- the next round can start from the merged artifact.

## First Job Contract

### TrainAdapterJob

Input:

```json
{
  "job_id": "job_123",
  "run_id": "run_italian_tinyllama_001",
  "round_id": "round_001",
  "job_type": "train_adapter",
  "backend": "mlx",
  "base_model": {
    "name": "TinyLlama-compatible-1.1B",
    "revision": "locked-revision",
    "hash": "sha256:..."
  },
  "dataset_shard": {
    "id": "shard_0001",
    "uri": "file://datasets/italian/shard_0001.jsonl",
    "token_estimate": 2000000,
    "hash": "sha256:..."
  },
  "lora_config": {
    "rank": 8,
    "alpha": 16,
    "dropout": 0.05
  },
  "limits": {
    "max_duration_seconds": 14400,
    "max_tokens": 2000000
  }
}
```

Output:

```json
{
  "job_id": "job_123",
  "artifact_type": "lora_adapter",
  "artifact_uri": "file://artifacts/job_123/adapter.safetensors",
  "artifact_hash": "sha256:...",
  "metrics_uri": "file://artifacts/job_123/metrics.json",
  "log_uri": "file://artifacts/job_123/train.log",
  "tokens_trained": 1983000,
  "duration_seconds": 13720,
  "peer_id": "12D3KooW...",
  "worker_id": "mac-studio-m2-ultra-01"
}
```

## First P2P Contracts

### Worker Registration

Protocol:

```text
/marshall/worker/register/1.0.0
```

Payload:

```json
{
  "peer_id": "12D3KooW...",
  "worker_id": "mac-studio-m2-ultra-01",
  "public_key": "base64-ed25519-public-key",
  "backend": "mlx",
  "device_family": "apple_silicon",
  "memory_gb": 128,
  "supported_jobs": ["train_adapter", "evaluate_model", "tokenize_dataset"],
  "benchmarks": {
    "tokens_per_second": 1400
  }
}
```

### Job Claim

Protocol:

```text
/marshall/job/claim/1.0.0
```

Payload:

```json
{
  "peer_id": "12D3KooW...",
  "worker_id": "mac-studio-m2-ultra-01",
  "job_type": "train_adapter",
  "backend": "mlx",
  "max_tokens": 2000000
}
```

### Artifact Manifest

Protocol:

```text
/marshall/artifact/manifest/1.0.0
```

Payload:

```json
{
  "peer_id": "12D3KooW...",
  "worker_id": "mac-studio-m2-ultra-01",
  "job_id": "job_123",
  "artifact_type": "lora_adapter",
  "artifact_uri": "file://artifacts/job_123/adapter.safetensors",
  "artifact_hash": "sha256:...",
  "config_hash": "sha256:...",
  "created_at": "2026-06-29T00:00:00Z"
}
```

## Round Completion Rule

```text
round is complete when:
  accepted_tokens >= target_tokens
  AND accepted_artifacts >= min_accepted_artifacts
  OR round_deadline is reached
```

No round waits for every worker.

## MVP Implementation Order

1. Define schemas for workers, jobs, artifacts, runs, rounds, and libp2p payloads.
2. Build a minimal libp2p control peer and worker peer.
3. Implement persistent worker peer identity and bootstrap discovery.
4. Implement worker registration over `/marshall/worker/register/1.0.0`.
5. Build a local single-machine training script using MLX LoRA.
6. Build artifact hashing and manifest generation.
7. Implement job claim and status streams over libp2p.
8. Implement artifact manifest publication over libp2p.
9. Build validation checks.
10. Build adapter merge and evaluation.
11. Run the 3-worker loop.

## Key Risks

- MLX LoRA setup may be fragile across machines.
- Dataset and model downloads can dominate job time.
- Adapter merge quality may be weak without good validation.
- Worker failures must not stall a round.
- Hardware claims must not be trusted without benchmarks.
- libp2p NAT traversal can become a blocker without relay support.
