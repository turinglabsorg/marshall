# Marshall

Marshall is a permissionless training network for small language models.

It turns consumer machines into a verifiable LoRA worker swarm: Macs and GPUs join over libp2p, claim real dataset shards, fine-tune adapters, publish hash-checked artifacts, and earn or lose reputation through distributed validation.

Marshall is not trying to pretend that random public machines are one synchronous GPU cluster. The public network scales through many independent adapter jobs, evaluation jobs, validator quorum, leaderboard selection, and future replicated inference. Model-parallel training and sharded inference belong to trusted cluster mode, not the open swarm default.

## Live Network

- Training dashboard: <https://marshall.training>
- Worker onboarding guide: <https://marshall.training/AGENTS.md>
- Coordinator snapshot: <https://marshall.training/dashboard>
- libp2p control peer descriptor: <https://marshall.training/control.json>
- Roadmap: [ROADMAP.md](./ROADMAP.md)

The public swarm is permissionless. Workers join through `/control.json`; there is no public worker join token.

## What Marshall Does

Marshall coordinates bounded AI jobs across heterogeneous machines:

- creates dataset-backed training runs;
- splits datasets into content-addressed shards;
- exposes a libp2p control peer for worker registration, heartbeat, job claim, status, and artifact publication;
- lets workers train MLX LoRA adapters on assigned shards;
- transfers artifacts over chunked, hash-verified p2p payloads;
- creates downstream evaluation and validation jobs;
- records validator votes and reputation in a Redis-backed Go coordinator;
- hides stale workers from the live dashboard without deleting identity or reputation;
- selects accepted adapters through deterministic leaderboard policy.

The current public training target is adapter fine-tuning for SLMs. The roadmap adds richer model capability checks, larger-parameter adapter jobs, replicated distributed inference, and trusted cluster modes for workloads that cannot fit on one worker.

## Network Flow

```text
Dataset manifest
      |
Run/job publisher
      |
Go coordinator + Redis  <---- public dashboard
      |
TypeScript libp2p control peer
      |
Workers: mlx | cuda | cpu
      |
LoRA adapters, metrics, logs
      |
Evaluation jobs
      |
Validator jobs + reputation
      |
Leaderboard + model package
```

Workers never receive Redis credentials. Redis is private to the coordinator host. Public workers interact through libp2p protocols and the coordinator bridge.

## Current Status

Implemented:

- native Go coordinator with Redis state and append-only event stream;
- terminal-style public dashboard at `marshall.training`;
- permissionless libp2p control peer on public TCP `4001`;
- public `/control.json` for worker discovery;
- public `/AGENTS.md` worker onboarding;
- TypeScript libp2p worker/control protocols;
- persistent Ed25519 worker identities;
- persistent worker pool CLI with stable concurrent slots;
- MLX LoRA training runner;
- dataset manifest builder with HTTP/S shard URIs;
- dataset cache with file size and SHA-256 verification;
- chunked p2p artifact transfer with retry and final root hash checks;
- explicit adapter evaluation jobs (`eval_kind: ag_news` or `instruction_terms`) and validation jobs;
- quorum-based validator verdicts;
- worker reputation and suspension policy;
- accepted-only adapter leaderboard and model package path;
- round advancement CLI for evaluation scheduling, validation scheduling, accepted-only leaderboard selection, and verified model packaging;
- GCP small-VM deployment with Caddy HTTPS, local Redis, coordinator, and control peer services.

Not implemented yet:

- always-on round orchestration daemon from training to validation to next run;
- public `marshall.chat` inference gateway;
- CUDA worker backend;
- model cache capability reporting;
- trusted model-parallel cluster scheduling;
- incentives or payments.

## Worker Quick Start

For public participation, use the live guide:

```text
https://marshall.training/AGENTS.md
```

The worker flow is:

1. install Node.js 22+;
2. clone this repository;
3. install dependencies and build;
4. install an MLX Python environment on Apple Silicon;
5. fetch the live control address from `https://marshall.training/control.json`;
6. start `worker:pool:compiled` with `--job-type train_adapter`;
7. let the worker download only its assigned shard, verify hashes, train, and publish the artifact.

Generated worker state, dataset caches, model files, and artifacts stay under `.marshall/` and must not be committed.

## Local Development

Requirements:

- Node.js 22 or newer;
- Go 1.23+;
- Redis 7 for coordinator integration tests;
- Apple Silicon plus `mlx-lm` for MLX training jobs.

Install and build:

```bash
npm ci
npm run build
go test ./...
npm test
```

Run the coordinator locally:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go run ./cmd/marshall-coordinator
```

Start a local control peer:

```bash
MARSHALL_COORDINATOR_URL=http://127.0.0.1:8080 \
MARSHALL_CONTROL_LISTEN=/ip4/0.0.0.0/tcp/4001 \
MARSHALL_JOB_TYPE=train_adapter \
MARSHALL_JOB_COUNT=2 \
npm run control:start
```

Start a local worker:

```bash
npm run worker:pool -- \
  --control /ip4/127.0.0.1/tcp/4001/p2p/<control-peer-id> \
  --job-type train_adapter \
  --backend mlx \
  --concurrency 1 \
  --dataset-cache-dir .marshall/cache/datasets \
  --python ~/.marshall/mlx-venv/bin/python
```

`worker:pool` is long-running by default: each stable worker slot claims another compatible job after completing the previous one. Use `--max-jobs <n>` and `--exit-when-idle` only for bounded local tests or maintenance runs.
Keep `--key-dir` stable when reusing the same `--worker-id-prefix`; the coordinator binds worker identity to the libp2p peer key and rejects mismatches.

## Dataset Runs

Marshall jobs should be produced from dataset manifests, not hand-written shell loops. The generic run preparer creates a content-addressed dataset manifest, writes a run bundle, and emits `jobs/train-adapters.json` for the control peer:

```bash
npm run dataset:run:prepare -- \
  --input-jsonl .marshall/cache/raw/dolly/databricks-dolly-15k.jsonl \
  --dataset-dir .marshall/datasets/dolly-15k-window \
  --dataset-id databricks-dolly-15k-window \
  --run-id run_dolly_15k_001 \
  --run-dir .marshall/runs/run_dolly_15k_001 \
  --shard-count 32 \
  --job-count 32 \
  --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
  --iters 20 \
  --learning-rate 0.00001 \
  --num-layers 4 \
  --instruction-field instruction \
  --response-field response \
  --context-field context
```

For remote public workers, shard URIs must be worker-resolvable HTTP/S URLs and every file must carry a SHA-256 hash and optional byte size. Workers fail the job on hash or size mismatch.

External datasets and generated dataset artifacts are intentionally kept out of the repository unless explicitly approved.

## Adapter Evaluation Jobs

Evaluation semantics live in the job spec. `evaluate_adapter` jobs must include `eval_kind`, `model`, `max_examples`, and `max_tokens`; missing fields are schema errors, not defaults.

Generate evaluation jobs from stored adapter manifests:

```bash
npm run eval:jobs -- \
  --artifacts-dir .marshall/runs/<run-id>/artifacts \
  --artifact-uri-mode p2p \
  --eval-kind instruction_terms \
  --eval-file .marshall/datasets/<dataset-id>/eval/instruction_terms.jsonl \
  --eval-uri https://marshall.training/datasets/<dataset-id>/eval/instruction_terms.jsonl \
  --output .marshall/runs/<run-id>/jobs/evaluate-adapters.json \
  --run-id <eval-run-id> \
  --round-id <round-id> \
  --job-prefix <eval-job-prefix> \
  --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
  --max-examples 3 \
  --max-tokens 80
```

Use `eval_kind ag_news` for exact-label AG News scoring and `eval_kind instruction_terms` for held-out instruction generation checks. The worker records the evaluation kind in the produced metrics artifact so leaderboard and validator stages can reason about what was measured.

## Round Advancement

`round:advance` is the product path for moving a run forward without hand-writing downstream job files. It reads coordinator artifacts or an artifact snapshot, then performs the next eligible phase:

- schedules `evaluate_adapter` jobs from published `lora_adapter` artifacts;
- schedules quorum `validate_artifact` jobs from unvalidated `adapter_evaluation` artifacts;
- writes accepted-only leaderboard files and an optional verified model package after validation is finalized.

For unattended runs, use `round:daemon`. It polls live coordinator jobs/artifacts, waits for each phase to finish, writes filtered artifact snapshots for the active run, schedules evaluation and validation jobs, and writes the final leaderboard/model package after quorum verdicts are finalized. It is the operational path for public multi-Mac runs.

Example one-shot phase advancement:

```bash
npm run round:advance -- \
  --coordinator-url https://marshall.training \
  --phase auto \
  --jobs-dir .marshall/runs/<run-id>/jobs \
  --artifact-store-dir <control-artifact-store> \
  --eval-file <eval.jsonl> \
  --eval-uri https://marshall.training/datasets/<dataset-id>/eval/instruction_terms.jsonl \
  --eval-kind instruction_terms \
  --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
  --max-examples 3 \
  --max-tokens 80 \
  --package-dir <package-dir>
```

The public control peer should run with `--coordinator-jobs true`, so it reads queued job specs from the coordinator on every claim. The returned `control.job_type` and `control.jobs_file` are still useful for local/static debugging, but production runs should not require restarting the control peer between train, eval, and validation phases.

Example unattended round manager:

```bash
npm run round:daemon:compiled -- \
  --coordinator-url https://marshall.training \
  --run-id <run-id> \
  --round-id <round-id> \
  --jobs-dir .marshall/runs/<run-id>/jobs \
  --train-job-prefix <train-job-prefix> \
  --eval-job-prefix <eval-job-prefix> \
  --validation-job-prefix <validation-job-prefix> \
  --eval-file <eval.jsonl> \
  --eval-uri https://marshall.training/datasets/<dataset-id>/eval/instruction_terms.jsonl \
  --eval-kind instruction_terms \
  --model <base-model> \
  --max-examples <n> \
  --max-tokens <n> \
  --validators-per-artifact 2 \
  --quorum 2 \
  --min-accuracy 0.3 \
  --max-invalid-rate 0.2 \
  --min-examples 1 \
  --artifact-store-dir /var/lib/marshall/artifacts/control \
  --leaderboard-dir /var/lib/marshall/leaderboards/<run-id> \
  --package-dir /var/lib/marshall/model-packages/<run-id> \
  --top-k 10 \
  --require-verdict accepted
```

## Multi-Mac Workers

Use `worker:join:compiled` for a Mac that should remain available across train, evaluation, and validation phases. It fetches `/control.json`, starts separate persistent pools per role, and keeps role identities, caches, input artifacts, and outputs separated.

```bash
npm run worker:join:compiled -- \
  --control-url https://marshall.training/control.json \
  --worker-id-base "$(hostname)" \
  --state-dir .marshall/public-worker \
  --train-concurrency 1 \
  --eval-concurrency 1 \
  --validation-concurrency 2 \
  --python "$MARSHALL_PYTHON"
```

Increase role concurrency only after confirming memory headroom on that Mac. Keep the same `--worker-id-base` and `--state-dir` across restarts to preserve worker identity and reputation.

## Public Deployment

The current public trial deploy target is a small GCP VM:

- project: `iconic-elevator-394020`;
- instance: `marshall-micro-1`;
- machine type: `e2-small` with a 2GB swapfile;
- domain: `marshall.training`;
- HTTPS proxy: Caddy;
- coordinator: Go service on `127.0.0.1:8080`;
- control peer: Node.js libp2p service on TCP `4001`, serving live coordinator jobs with `--coordinator-jobs true`;
- Redis: local-only on the VM.

Deploy:

```bash
./scripts/deploy-gcp-micro.sh
```

The deploy script builds the TypeScript runtime and Go coordinator, uploads systemd services, keeps Redis private, publishes Caddy HTTPS, and writes `/control.json` for permissionless worker discovery.

## Architecture

Core components:

- `cmd/marshall-coordinator`: native Go coordinator daemon;
- `coordinator/`: Redis-backed state, HTTP API, dashboard, reputation, validation votes;
- `src/control-peer.ts`: libp2p control peer and worker protocol handlers;
- `src/worker-peer.ts`: worker registration, heartbeat, claim, status, and artifact publication;
- `src/worker-supervisor-cli.ts`: multi-role Mac worker supervisor for train/eval/validation pools;
- `src/round-daemon-cli.ts`: unattended train/eval/validation/selection round manager;
- `src/training-runner.ts`: training, evaluation, and validation runner bridge;
- `src/dataset-manifest.ts`: content-addressed dataset manifest generation;
- `src/artifact-transfer.ts`: chunked p2p artifact transfer and verification;
- `training/`: MLX and local smoke training scripts;
- `ROADMAP.md`: product and architecture roadmap.

Important protocol families:

```text
/marshall/worker/register/1.0.0
/marshall/worker/heartbeat/1.0.0
/marshall/job/claim/1.0.0
/marshall/job/status/1.0.0
/marshall/artifact/manifest/1.0.0
/marshall/artifact/fetch/1.0.0
```

## Reputation And Validation

Marshall is permissionless, but accepted work is not trustless-by-default. Artifacts are evaluated and validated before they affect model selection.

Current score policy:

| Verdict | Score Delta | Meaning |
| --- | ---: | --- |
| `accepted` | `+2` | Artifact passed validation |
| `poor` | `-10` | Artifact is valid but low quality |
| `rejected` | `-25` | Artifact failed validation |
| `timeout` | `-15` | Worker held a job until its lease expired |
| `malicious` | `-100` | Strong sabotage or canary failure signal |

Workers start at `100`, become `degraded` below `70`, and become `suspended` below `20`. Suspended workers cannot claim new jobs. Stale workers disappear from the live dashboard after 15 minutes without recent activity, but identity and reputation records stay in Redis.

## Verification

Use Node.js 22+ for JavaScript tests.

```bash
nvm use
npm run build
npm test
go test ./...
```

Additional checks:

```bash
npm run dataset:marshall:check
npm run dataset:ag-news:check
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go test ./...
MARSHALL_COORDINATOR_URL=http://127.0.0.1:8080 npm test
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:smoke
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:lora
```

The p2p tests open real TCP sockets on `127.0.0.1`. MLX tests require Apple Silicon and an MLX-capable Python environment.

## Non-Goals

- no public worker join token for the permissionless swarm;
- no Redis access for workers;
- no blockchain, token, or payment layer before validation and reputation are reliable;
- no synchronous optimizer steps across random public Internet workers;
- no single inference request split across arbitrary permissionless machines;
- no unvalidated artifact entering model selection;
- no generated datasets, model files, local harness artifacts, or exploratory fixtures committed to the repository.

## License

Marshall source code is MIT licensed. External datasets, generated training artifacts, and model outputs are not published from this repository.
