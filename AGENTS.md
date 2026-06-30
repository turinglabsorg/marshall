# Marshall Agent Notes

Marshall is a p2p-first consumer AI compute network for asynchronous AI workloads.

## Architecture Direction

- Use libp2p from the first implementation milestone.
- The coordinator is a control peer, not only an HTTP service.
- Workers are libp2p peers with persistent Ed25519 identities.
- Worker registration, job claim, job status, heartbeat, and artifact manifests must work over libp2p streams.
- HTTP endpoints are admin/debug/dashboard conveniences, not the primary worker network.
- Target public participation: unknown workers may onboard, but trusted work requires validator verdicts, reputation, and coordinator-enforced suspension for bad actors.

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
- `src/control-cli.ts` supports `--jobs-file` / `MARSHALL_JOBS_FILE` for mixed Marshall job definitions, including `evaluate_adapter` and `validate_artifact` jobs generated from coordinator artifacts.
- `src/worker-cli.ts` starts a one-job worker that registers, claims, runs, publishes an artifact, and exits.
- `src/worker-pool-cli.ts` starts bounded concurrent worker processes against a control peer. Use this for product E2E proof instead of manual shell loops.
- `src/jobs.ts` defines local `train_toy_model`, `train_mlx_smoke`, and `train_adapter` job builders.
- `src/control-peer.ts` implements the in-memory control peer and handlers for worker registration, heartbeat, job claim, job status, and artifact manifests.
- `src/coordinator-client.ts` lets the TypeScript control peer persist lifecycle events into the Go coordinator over HTTP when `coordinatorUrl` is configured, sends the full `MarshallJob` as `job_spec`, and can read persisted jobs/artifacts back from the coordinator.
- `src/coordinator-client.ts` supports coordinator write authentication with `MARSHALL_COORDINATOR_TOKEN` / `--coordinator-token` and worker heartbeat forwarding for live coordinator leases.
- `src/coordinator-client.ts` can record artifact verdicts and read worker reputation through the coordinator API.
- `src/coordinator-client.ts` can list coordinator artifacts; `src/validation-jobs-cli.ts` turns unvalidated target artifacts into distributed `validate_artifact` jobs, scopes targets with `--target-job-prefix`, and defaults to quorum 2 with two validator jobs per artifact.
- `src/worker-peer.ts` implements a worker peer that dials the control peer and drives the first job lifecycle.
- `src/worker-peer.ts` supports optional swarm authentication with `MARSHALL_SWARM_TOKEN` / `--swarm-token` so untrusted peers cannot register or claim jobs from permissioned control peers.
- `src/training-runner.ts` runs the local toy trainer for `train_toy_model` jobs and validates the emitted manifest and metrics.
- `src/training-runner.ts` also wraps `training/mlx_linear_smoke.py` for `train_mlx_smoke` jobs and emits an `mlx_smoke_result` artifact manifest.
- `src/training-runner.ts` wraps `training/mlx_lora_smoke.py` for `train_adapter` jobs and emits a `lora_adapter` artifact manifest.
- `src/training-runner.ts` wraps `training/mlx_ag_news_eval.py` for `evaluate_adapter` jobs and emits an `adapter_evaluation` artifact manifest.
- `src/training-runner.ts` runs `validate_artifact` jobs for validator workers. The current validator checks target artifact hash and adapter-evaluation metrics, then emits an `artifact_validation` manifest with `accepted`, `poor`, `rejected`, or `malicious` plus the requested quorum.
- `src/control-peer.ts` forwards `artifact_validation` manifests into coordinator validator votes, so target worker reputation is updated only after a verdict reaches coordinator quorum.
- `src/evaluation-jobs-cli.ts` scans `lora_adapter` manifests and creates `evaluate_adapter` jobs for a held-out eval shard.
- `src/leaderboard-cli.ts` scans `adapter_evaluation` metrics and writes `leaderboard.json`, `top_k.json`, and `optimized_model.json`. With `--coordinator-url --require-verdict accepted`, it filters model selection to coordinator-accepted artifacts only.
- `src/model-package-cli.ts` packages the selected optimized model as base model + LoRA adapter metadata and emits an `optimized_model_package` manifest.
- `src/model-query-cli.ts` queries a packaged optimized model against a selected eval record and can fail unless the answer is correct.
- `src/e2e-ag-news-cli.ts` runs the AG News product E2E path: training worker pool, evaluation worker pool, leaderboard, package, query, and optional coordinator persistence verification.
- `training/tiny_char_lm.py` trains a tiny character bigram language model with stdlib-only SGD and writes `model.json`, `metrics.json`, `train.log`, and `manifest.json`.
- `training/mlx_linear_smoke.py` verifies MLX GPU execution with a tiny gradient-descent job on Apple Silicon.
- `training/mlx_lora_smoke.py` runs a tiny MLX-LM LoRA training job, writes logs and `metrics.json`, captures train/validation loss, and validates adapter files.
- `training/build_marshall_instruction_dataset.py` generates and validates deterministic train/valid/test/eval splits for Marshall coordinator-event tasks.
- `training/mlx_lora_eval.py` runs held-out generation checks against a base model or LoRA adapter and writes eval metrics.
- `training/build_ag_news_dataset.py` downloads AG News CSVs into `.marshall/cache/raw/ag-news`, builds local train/valid/test/eval JSONL plus 4 shards under `.marshall/datasets/ag-news`, and writes a manifest consumed by adapter job creation.
- `npm run dataset:ag-news:micro:build` uses the same real AG News builder to create many non-fake micro-shards under `.marshall/datasets/ag-news-micro`; `MARSHALL_MICRO_SHARDS` controls the shard/job count.
- `training/mlx_ag_news_eval.py` evaluates base models or LoRA adapters on AG News exact-label accuracy.
- `src/dataset-cache.ts` materializes assigned dataset shards into a content-addressed local cache and verifies hashes before training or evaluation. Single JSONL eval shards remain addressable as files after caching.
- `examples/datasets/tiny-italian.jsonl` is the tiny local JSONL dataset used by the smoke training job.
- `examples/datasets/marshall-instructions/manifest.json`, `{train,valid,test,eval}.jsonl`, and `shards/shard-*/{train,valid}.jsonl` are the private synthetic MIT dataset artifacts for Marshall coordinator-event summaries and multi-worker adapter claims.
- `src/schemas.ts` defines Zod schemas for worker registration, heartbeat, job claim, `TrainingJob`, `AdapterEvaluationJob`, `ArtifactValidationJob`, `MarshallJob`, job status, artifact manifest, toy training metrics, MLX smoke metrics, MLX LoRA metrics, adapter evaluation metrics, artifact validation metrics, and ACK payloads. `ArtifactValidationPolicy.quorum` controls how many matching validator votes are required. `TrainingJob.dataset_shard`, `AdapterEvaluationJob.eval_shard`, and `ArtifactValidationJob.target` must include hashes verified by workers before producing artifacts or verdicts.
- `src/jobs.ts` supports `adapterDataset: "ag_news"` through a local manifest. The control CLI exposes this as `--adapter-dataset ag_news` or `MARSHALL_ADAPTER_DATASET=ag_news`, with `--adapter-dataset-dir` / `MARSHALL_ADAPTER_DATASET_DIR` pointing at the local dataset directory.
- `tests/jobs.test.ts` verifies the adapter job builder and MLX default backend.
- `tests/p2p.integration.test.ts` starts real libp2p peers on localhost, runs the toy trainer, checks loss improvement, verifies artifact manifest publication, and covers four workers claiming independent jobs concurrently.
- `tests/coordinator-bridge.integration.test.ts` verifies that the p2p lifecycle is persisted into the Go coordinator event log when `MARSHALL_COORDINATOR_URL` is set, including distributed artifact validation manifest to coordinator verdict bridging.
- `tests/artifact-validation.test.ts` verifies accepted and malicious validator outcomes against real artifact hashes and adapter-evaluation metrics.
- `cmd/marshall-coordinator` is the native Go coordinator entry point.
- `coordinator/redis_store.go` stores runs, workers, jobs, full job specs, job claims, statuses, artifacts, and append-only events in Redis.
- `coordinator/redis_store.go` maintains job leases and can requeue expired running jobs so abandoned work is visible and recoverable.
- `coordinator/redis_store.go` tracks worker reputation and blocks suspended workers from claiming more jobs. Artifact verdicts with `quorum > 1` are stored as per-validator votes first and finalize only when one verdict reaches quorum. Verdict policy is currently `accepted +2`, `poor -10`, `rejected -25`, `timeout -15`, and `malicious -100`, capped to the `0..100` score range.
- `coordinator/http.go` exposes the coordinator HTTP admin API, including `GET /jobs/{job_id}`, `GET /artifacts`, `GET /artifacts/{job_id}`, `POST /artifacts/{job_id}/verdict`, `GET /workers/{worker_id}/reputation`, `POST /jobs/requeue-expired`, `GET /dashboard`, `GET /events/stream`, and the embedded public console at `/`.
- `coordinator/http.go` enforces optional bearer-token write authentication when `MARSHALL_COORDINATOR_TOKEN` is set; read endpoints remain available for the public console.
- `coordinator/public/index.html` is the embedded terminal-style swarm console for worker status, job status, artifact verdicts, and live coordinator events.
- `coordinator/public/AGENTS.md` is the public worker onboarding file served at `/AGENTS.md`.
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

Product E2E validation should use this shape:

```bash
npm run control:start -- --job-type train_adapter --job-count 4 --adapter-dataset ag_news
npm run worker:pool -- --control <control-multiaddr> --job-type train_adapter --concurrency 4 --max-jobs 4
npm run eval:jobs -- --artifacts-dir <adapter-artifacts> --eval-file <eval.jsonl> --output <eval-jobs.json>
npm run control:start -- --job-type evaluate_adapter --jobs-file <eval-jobs.json>
npm run worker:pool -- --control <control-multiaddr> --job-type evaluate_adapter --concurrency 4 --max-jobs 4
npm run validation:jobs -- --coordinator-url <coordinator-url> --target-artifact-type adapter_evaluation --quorum 2 --validators-per-artifact 2 --output <validation-jobs.json>
npm run control:start -- --job-type validate_artifact --jobs-file <validation-jobs.json>
npm run worker:pool -- --control <control-multiaddr> --job-type validate_artifact --backend cpu --concurrency 4 --max-jobs 4
npm run leaderboard:adapters -- --eval-artifacts-dir <eval-artifacts> --coordinator-url <coordinator-url> --require-verdict accepted --output-dir <leaderboard-dir>
npm run model:package -- --optimized-model <leaderboard-dir>/optimized_model.json --output-dir <package-dir>
npm run model:query -- --package <package-dir>/model_package.json --eval-file <eval.jsonl> --require-correct true
```

Prefer the single product runner when validating the whole AG News path:

```bash
npm run e2e:ag-news:compiled -- --coordinator-url http://127.0.0.1:8080 --python ~/.marshall/mlx-venv/bin/python
```

The p2p integration test opens real TCP sockets on `127.0.0.1`, so sandboxed agents may need escalated execution for test/runtime commands.
The MLX smoke test requires Apple Silicon plus an MLX-capable Python environment.
The MLX LoRA train/eval tests require Apple Silicon plus `mlx-lm` installed in the worker Python environment.
Redis coordinator tests require a real Redis instance; use `redis:7-alpine` for local integration testing.
The coordinator bridge test requires a running Go coordinator backed by Redis.
External datasets must stay out of the repo until license and distribution policy are explicitly reviewed.

## Development Rules

- Keep all docs in English.
- Build and test Marshall as a product, not as manual orchestration. Do not replace missing product behavior with shell loops, ad hoc scripts, or the agent acting as the coordinator.
- E2E validation must go through Marshall contracts: coordinator creates jobs, workers claim and run them, artifacts are published, evaluation jobs are scheduled, leaderboard/top-K is derived from artifacts, and only then merge/selection runs.
- Manual shell commands are allowed only to start/stop services, inspect state, or run tests. If a repeated/manual operational step is needed to prove the system, implement it as Marshall code or documented CLI behavior first.
- Do not add blockchain, token, payment, or incentive code before validation and reputation work.
- Do not build synchronous distributed training.
- Do not assume all workers are equally capable.
- Runtime-test networking changes with at least one control peer and one worker peer before marking them done.
- For backend/API functions, add integration tests.
- Runtime-test coordinator storage/API changes against real Redis before pushing.
