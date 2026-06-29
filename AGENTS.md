# Marshall Agent Notes

Marshall is a p2p-first consumer AI compute network for asynchronous AI workloads.

## Architecture Direction

- Use libp2p from the first implementation milestone.
- The coordinator is a control peer, not only an HTTP service.
- Workers are libp2p peers with persistent Ed25519 identities.
- Worker registration, job claim, job status, heartbeat, and artifact manifests must work over libp2p streams.
- HTTP endpoints are admin/debug/dashboard conveniences, not the primary worker network.
- Start permissioned: unknown peers must not receive trusted jobs.

## Initial Stack

- Node.js 22+ runtime for current js-libp2p dependencies.
- TypeScript libp2p for the p2p substrate.
- Python stdlib toy training runner for lightweight end-to-end smoke tests.
- Python MLX-LM runner for Apple Silicon LoRA jobs.
- Go for the native coordinator daemon.
- Redis for coordinator state and append-only event logs.
- Local filesystem artifacts for MVP storage.

## First Protocols

```text
/marshall/worker/register/1.0.0
/marshall/worker/heartbeat/1.0.0
/marshall/job/offer/1.0.0
/marshall/job/claim/1.0.0
/marshall/job/status/1.0.0
/marshall/artifact/manifest/1.0.0
```

## Implemented Prototype

- `src/node.ts` creates TCP + Noise + Yamux libp2p nodes with optional bootstrap and mDNS discovery.
- `src/identity.ts` persists Ed25519 private keys on disk.
- `src/control-cli.ts` starts a long-running configurable libp2p control peer.
- `src/control-cli.ts` supports `MARSHALL_JOB_COUNT` / `--job-count`; multi-job adapter runs use deterministic dataset shard jobs.
- `src/worker-cli.ts` starts a one-job worker that registers, claims, runs, publishes an artifact, and exits.
- `src/jobs.ts` defines local `train_toy_model`, `train_mlx_smoke`, and `train_adapter` job builders.
- `src/control-peer.ts` implements the in-memory control peer and handlers for worker registration, heartbeat, job claim, job status, and artifact manifests.
- `src/coordinator-client.ts` lets the TypeScript control peer persist lifecycle events into the Go coordinator over HTTP when `coordinatorUrl` is configured.
- `src/worker-peer.ts` implements a worker peer that dials the control peer and drives the first job lifecycle.
- `src/training-runner.ts` runs the local toy trainer for `train_toy_model` jobs and validates the emitted manifest and metrics.
- `src/training-runner.ts` also wraps `training/mlx_linear_smoke.py` for `train_mlx_smoke` jobs and emits an `mlx_smoke_result` artifact manifest.
- `src/training-runner.ts` wraps `training/mlx_lora_smoke.py` for `train_adapter` jobs and emits a `lora_adapter` artifact manifest.
- `training/tiny_char_lm.py` trains a tiny character bigram language model with stdlib-only SGD and writes `model.json`, `metrics.json`, `train.log`, and `manifest.json`.
- `training/mlx_linear_smoke.py` verifies MLX GPU execution with a tiny gradient-descent job on Apple Silicon.
- `training/mlx_lora_smoke.py` runs a tiny MLX-LM LoRA training job, writes logs and `metrics.json`, captures train/validation loss, and validates adapter files.
- `training/build_marshall_instruction_dataset.py` generates and validates deterministic train/valid/test/eval splits for Marshall coordinator-event tasks.
- `training/mlx_lora_eval.py` runs held-out generation checks against a base model or LoRA adapter and writes eval metrics.
- `examples/datasets/tiny-italian.jsonl` is the tiny local JSONL dataset used by the smoke training job.
- `examples/datasets/marshall-instructions/{train,valid,test,eval}.jsonl` plus `shards/shard-*/{train,valid}.jsonl` is the tiny chat/eval dataset for Marshall coordinator-event summaries and multi-worker adapter claims.
- `src/schemas.ts` defines Zod schemas for worker registration, heartbeat, job claim, `TrainingJob`, job status, artifact manifest, toy training metrics, MLX smoke metrics, MLX LoRA metrics, and ACK payloads.
- `tests/jobs.test.ts` verifies the adapter job builder and MLX default backend.
- `tests/p2p.integration.test.ts` starts real libp2p peers on localhost, runs the toy trainer, checks loss improvement, verifies artifact manifest publication, and covers four workers claiming independent jobs concurrently.
- `tests/coordinator-bridge.integration.test.ts` verifies that the p2p lifecycle is persisted into the Go coordinator event log when `MARSHALL_COORDINATOR_URL` is set.
- `cmd/marshall-coordinator` is the native Go coordinator entry point.
- `coordinator/redis_store.go` stores runs, workers, jobs, job claims, statuses, artifacts, and append-only events in Redis.
- `coordinator/http.go` exposes the initial coordinator HTTP admin API.
- `coordinator/*_integration_test.go` verifies the Redis store and HTTP lifecycle against a real Redis server when `MARSHALL_REDIS_ADDR` is set.

## Verification

Use Node.js 22+.

```bash
nvm use
npm run typecheck
npm run dataset:marshall:check
npm test
npm run demo:compiled
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:smoke
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:lora
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:lora:eval
go test ./...
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go test ./...
MARSHALL_COORDINATOR_URL=http://127.0.0.1:8080 npm test
```

The p2p integration test opens real TCP sockets on `127.0.0.1`, so sandboxed agents may need escalated execution for test/runtime commands.
The MLX smoke test requires Apple Silicon plus an MLX-capable Python environment.
The MLX LoRA train/eval tests require Apple Silicon plus `mlx-lm` installed in the worker Python environment.
Redis coordinator tests require a real Redis instance; use `redis:7-alpine` for local integration testing.
The coordinator bridge test requires a running Go coordinator backed by Redis.

## Development Rules

- Keep all docs in English.
- Do not add blockchain, token, payment, or incentive code before validation and reputation work.
- Do not build synchronous distributed training.
- Do not assume all workers are equally capable.
- Runtime-test networking changes with at least one control peer and one worker peer before marking them done.
- For backend/API functions, add integration tests.
- Runtime-test coordinator storage/API changes against real Redis before pushing.
