# Marshall

Marshall is a p2p-first consumer AI compute network for asynchronous AI workloads on Apple Silicon Macs, consumer NVIDIA machines, and CPU-only nodes.

The first product is not a model. The first product is the network substrate:

- a coordinator/control peer that creates runs, schedules work, tracks status, and manages rounds;
- a libp2p peer network that connects coordinator, workers, relay nodes, and future validators from day one;
- a worker daemon that registers capabilities, claims jobs, runs tasks, and publishes artifact manifests over p2p streams;
- an artifact registry for adapters, logs, datasets, evaluations, and manifests;
- a scheduler that understands heterogeneous hardware;
- a validation layer that scores contributions before they affect global state;
- a reputation model used for scheduling before incentives.

Marshall should behave like a compute marketplace for bounded AI jobs, not like a synchronous GPU cluster.

## Coordinator

Marshall now includes a native Go coordinator prototype backed by Redis:

- `cmd/marshall-coordinator` exposes a small HTTP admin API;
- `coordinator/redis_store.go` stores derived state in Redis hashes/sets;
- Redis Streams provide the append-only event log;
- job claims are atomic through a Redis Lua script;
- worker claims require a registered worker identity and are rejected once the worker is suspended;
- artifact verdicts update worker reputation and can progressively degrade or suspend bad workers;
- the TypeScript libp2p control peer can bridge worker lifecycle events into the coordinator through `coordinatorUrl`.

Run it locally with Redis:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go run ./cmd/marshall-coordinator
```

### Public Worker Reputation

Marshall is moving toward open worker participation with validator-driven slashing instead of a permanently permissioned worker set. The current coordinator policy is intentionally simple and deterministic:

| Verdict | Score Delta | Meaning |
|---------|-------------|---------|
| `accepted` | `+2` | Artifact passed validation |
| `poor` | `-10` | Artifact is valid but low quality |
| `rejected` | `-25` | Artifact failed validation |
| `timeout` | `-15` | Worker held a job until its lease expired |
| `malicious` | `-100` | Strong sabotage/canary failure signal |

Worker reputation starts at `100`, is capped to `0..100`, becomes `degraded` below `70`, and becomes `suspended` below `20`. Suspended workers cannot claim new jobs.

Coordinator endpoints:

```text
GET  /artifacts
POST /artifacts/{job_id}/verdict
GET  /workers/{worker_id}/reputation
```

Only the coordinator writes Redis. Workers do not receive Redis credentials and interact through libp2p worker protocols.

### Distributed Artifact Validation

Validation is modeled as ordinary p2p work, not as an operator-side manual step:

- evaluation artifacts are published to the coordinator by the worker that produced them;
- `npm run validation:jobs` reads unvalidated coordinator artifacts and creates multiple `validate_artifact` jobs per target artifact;
- validator workers claim those jobs through libp2p and emit `artifact_validation` manifests;
- the control peer converts `artifact_validation` manifests into coordinator validator votes;
- the coordinator finalizes a target artifact only after a verdict reaches quorum, then updates target worker reputation once;
- leaderboard/model selection can require `verdict=accepted` before an adapter enters the selected set.

## First Concrete Target

Build a real 3-worker p2p loop:

- 1 coordinator/control peer;
- 1 libp2p bootstrap/relay peer, colocated with the coordinator at first;
- 3 Apple Silicon workers with persistent libp2p identities;
- 1 TinyLlama-class base model;
- 1 Italian JSONL dataset split into shards;
- 1 MLX LoRA backend;
- 1 adapter validator;
- 1 merge script;
- 1 evaluation script.

The first milestone is complete when workers discover the network through libp2p, register capabilities, claim training jobs, publish artifact manifests, pass validation, merge accepted adapters, evaluate the merged adapter, and start the next round.

## Non-Goals

- No blockchain or token layer in the first version.
- No synchronous distributed training.
- No attempt to make consumer machines behave like one datacenter GPU cluster.
- No full-model pretraining as the first workload.
- No rewards before validation and reputation are reliable.
- No assumption that HTTP polling is the worker network.

## Repository Shape

```text
marshall/
  src/
    control-cli.ts
    control-peer.ts
    coordinator-client.ts
    worker-cli.ts
    worker-peer.ts
    training-runner.ts
  training/
    tiny_char_lm.py
    mlx_linear_smoke.py
    mlx_lora_smoke.py
    build_marshall_instruction_dataset.py
    build_ag_news_dataset.py
    mlx_ag_news_eval.py
  coordinator/
    redis_store.go
    http.go
  cmd/
    marshall-coordinator/
      main.go
  docs/
    architecture.md
    p2p.md
    mvp.md
    backlog.md
```

The implementation starts with the libp2p substrate, a lightweight local training smoke test, and the MVP contracts in `docs/mvp.md`.

## Prototype Status

The first p2p substrate and toy training prototype is implemented.

It proves:

- a libp2p control peer can listen on localhost over TCP;
- a worker peer can dial it over libp2p;
- the worker can register over `/marshall/worker/register/1.0.0`;
- the worker can send heartbeat, job claim, job status, and artifact manifest messages over versioned libp2p streams;
- the control peer can assign one `train_toy_model` job and accept the worker artifact manifest only when it matches the assigned worker;
- the worker can run a real stdlib-only Python character bigram training job against a built-in inline smoke dataset materialized into the local dataset cache;
- the training runner emits `model.json`, `metrics.json`, `train.log`, and a `toy_language_model` manifest.
- `training/mlx_linear_smoke.py` verifies that a remote Apple Silicon worker can run a tiny MLX gradient-descent job on GPU.
- `train_mlx_smoke` can be assigned through the p2p lifecycle and emits an `mlx_smoke_result` artifact manifest.
- `train_adapter` runs a tiny MLX-LM LoRA job against a generated local `.marshall/datasets/marshall-instructions` dataset and emits a `lora_adapter` artifact manifest.
- `training/build_marshall_instruction_dataset.py` generates and validates deterministic train/valid/test/eval splits for Marshall coordinator-event tasks under `.marshall/datasets/marshall-instructions`.
- `training/mlx_lora_eval.py` runs held-out generation checks against a base model or LoRA adapter and writes `eval.json` metrics.
- `MARSHALL_JOB_COUNT` lets the control CLI create multiple jobs in one run; `train_adapter` uses dataset shards for multi-worker claims.
- workers materialize only the assigned shard into a content-addressed cache under `.marshall/cache/datasets/<sha256>` before training.
- `training/build_ag_news_dataset.py` builds a local private AG News classification dataset under `.marshall/datasets/ag-news`, and `training/mlx_ag_news_eval.py` scores base-model or adapter exact-label accuracy.
- `validate_artifact` jobs let validator workers verify target artifact hashes and adapter-evaluation metrics before artifacts can affect coordinator reputation or accepted-only model selection.
- validator workers reject internally inconsistent adapter-evaluation metrics as malicious, including impossible example counts, correct/invalid counts, rates, or labels outside the declared label set.
- worker CLIs accept multiple control multiaddrs and fall back when a dial fails, which is required for real LAN/VPN/firewall variation across machines.
- artifact payloads can move over `/marshall/artifact/fetch/1.0.0`; transfers are chunked, hash-checked per chunk and per file, retried on corrupt chunks, and verified against the final artifact root hash.
- control peers can store verified worker artifacts locally and serve them back to downstream workers through `marshall-artifact://<job_id>` inputs, so remote evaluation and validation do not depend on coordinator-local filesystem paths.
- adapter leaderboard outputs include an explicit `selection_policy` with score formula, tie breakers, top-K, required verdict, and current `single_adapter` merge mode.

## CLI Runtime

Start a control peer with a Redis-backed coordinator:

```bash
MARSHALL_COORDINATOR_URL=http://127.0.0.1:8080 \
MARSHALL_CONTROL_LISTEN=/ip4/0.0.0.0/tcp/4001 \
MARSHALL_JOB_TYPE=train_adapter \
MARSHALL_JOB_COUNT=2 \
npm run control:start
```

Use the local AG News profile after building the dataset:

```bash
npm run dataset:ag-news:build
MARSHALL_ADAPTER_DATASET=ag_news \
MARSHALL_ADAPTER_DATASET_DIR=.marshall/datasets/ag-news \
MARSHALL_JOB_TYPE=train_adapter \
MARSHALL_JOB_COUNT=4 \
npm run control:start
```

For large-scale scheduling tests without fake adapters, build a micro-sharded AG News dataset. Each shard still contains real AG News examples and each job trains a real LoRA adapter:

```bash
MARSHALL_MICRO_SHARDS=128 npm run dataset:ag-news:micro:build
MARSHALL_ADAPTER_DATASET=ag_news \
MARSHALL_ADAPTER_DATASET_DIR=.marshall/datasets/ag-news-micro \
MARSHALL_JOB_TYPE=train_adapter \
MARSHALL_JOB_COUNT=128 \
npm run control:start
```

Start a worker against a control multiaddr:

```bash
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python \
npm run worker:start -- \
  --control /ip4/127.0.0.1/tcp/4001/p2p/<control-peer-id> \
  --job-type train_adapter \
  --backend mlx \
  --worker-id macbook-mlx-01 \
  --dataset-cache-dir .marshall/cache/datasets \
  --iters 20 \
  --batch-size 1 \
  --num-layers 4
```

For remote workers, pass every usable control address. The worker tries them in order, remembers the first successful address, and falls back if a later dial fails. If a LAN address times out while basic TCP probes succeed, check the host firewall and keep a second route, such as a VPN or relay multiaddr, in the list:

```bash
npm run worker:start -- \
  --control /ip4/192.168.1.129/tcp/4001/p2p/<control-peer-id>,/ip4/100.102.25.69/tcp/4001/p2p/<control-peer-id> \
  --job-type train_adapter \
  --backend mlx \
  --worker-id macbook-mlx-01
```

For product E2E runs, keep artifact payloads on the p2p artifact plane. The control peer should materialize verified copies, and generated downstream jobs should reference them with `marshall-artifact://<job_id>`:

```bash
MARSHALL_JOB_TYPE=train_adapter \
npm run control:start -- \
  --artifact-store-dir .marshall/runs/<run-id>/train-artifacts

npm run eval:jobs -- \
  --artifacts-dir .marshall/runs/<run-id>/train-artifacts \
  --artifact-uri-mode p2p \
  --eval-file .marshall/datasets/ag-news/eval.jsonl \
  --output .marshall/runs/<run-id>/eval-jobs.json

MARSHALL_JOB_TYPE=evaluate_adapter \
MARSHALL_JOBS_FILE=.marshall/runs/<run-id>/eval-jobs.json \
npm run control:start -- \
  --artifact-store-dir .marshall/runs/<run-id>/eval-artifacts \
  --artifact-serve-dirs .marshall/runs/<run-id>/train-artifacts
```

Create and run validation work after evaluation artifacts have been published to the coordinator:

```bash
npm run validation:jobs -- \
  --coordinator-url http://127.0.0.1:8080 \
  --target-artifact-type adapter_evaluation \
  --target-uri-mode p2p \
  --quorum 2 \
  --validators-per-artifact 2 \
  --output .marshall/jobs/validate-artifacts.json

MARSHALL_JOBS_FILE=.marshall/jobs/validate-artifacts.json \
MARSHALL_JOB_TYPE=validate_artifact \
npm run control:start -- \
  --artifact-store-dir .marshall/validation-artifacts \
  --artifact-serve-dirs .marshall/eval-artifacts

npm run worker:pool -- \
  --control /ip4/127.0.0.1/tcp/4001/p2p/<control-peer-id> \
  --job-type validate_artifact \
  --backend cpu \
  --concurrency 2 \
  --max-jobs 2 \
  --input-artifacts-dir .marshall/validation-inputs
```

Build a leaderboard from only accepted evaluation artifacts:

```bash
npm run leaderboard:adapters -- \
  --eval-artifacts-dir .marshall/eval-artifacts \
  --coordinator-url http://127.0.0.1:8080 \
  --require-verdict accepted \
  --output-dir .marshall/leaderboard
```

## Development

Use Node.js 22 or newer.

```bash
nvm use
npm install
npm run build
npm run dataset:marshall:check
npm run dataset:ag-news:build
npm run dataset:ag-news:check
MARSHALL_MICRO_SHARDS=128 npm run dataset:ag-news:micro:build
MARSHALL_MICRO_SHARDS=128 npm run dataset:ag-news:micro:check
npm test
npm run demo:compiled
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:smoke
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:lora
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:lora:eval
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python npm run test:mlx:ag-news:eval
go test ./...
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go test ./...
MARSHALL_COORDINATOR_URL=http://127.0.0.1:8080 npm test
```

The integration test opens real TCP sockets on `127.0.0.1`, starts a control peer and worker peer, and verifies the full p2p job lifecycle.
It also runs the toy trainer and asserts that the loss decreases before publishing the artifact manifest.
The MLX smoke test is intended for Apple Silicon workers with MLX installed and verifies GPU execution.
The Redis-backed coordinator integration tests require a reachable Redis server.
The coordinator bridge test requires the Go coordinator running and verifies that p2p worker registration, job claim, status, and artifact publication are persisted as coordinator events.

Dataset artifacts are private/local for now. Generated datasets, external datasets, local harness artifacts, and exploratory fixtures stay outside the repo unless explicitly approved for repository inclusion.

## License

Marshall source code is MIT licensed. The project remains private for structure validation; external datasets and generated training artifacts are not published from this repository.
