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
- job claims are atomic through a Redis Lua script.
- the TypeScript libp2p control peer can bridge worker lifecycle events into the coordinator through `coordinatorUrl`.

Run it locally with Redis:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go run ./cmd/marshall-coordinator
```

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
    build_ag_news_dataset.py
    mlx_ag_news_eval.py
  coordinator/
    redis_store.go
    http.go
  cmd/
    marshall-coordinator/
      main.go
  examples/
    datasets/
      tiny-italian.jsonl
      marshall-instructions/
        manifest.json
        train.jsonl
        valid.jsonl
        test.jsonl
        eval.jsonl
        shards/
          shard-001/
          shard-002/
          shard-003/
          shard-004/
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
- the worker can run a real stdlib-only Python character bigram training job against `examples/datasets/tiny-italian.jsonl`;
- the training runner emits `model.json`, `metrics.json`, `train.log`, and a `toy_language_model` manifest.
- `training/mlx_linear_smoke.py` verifies that a remote Apple Silicon worker can run a tiny MLX gradient-descent job on GPU.
- `train_mlx_smoke` can be assigned through the p2p lifecycle and emits an `mlx_smoke_result` artifact manifest.
- `train_adapter` runs a tiny MLX-LM LoRA job against `examples/datasets/marshall-instructions` and emits a `lora_adapter` artifact manifest.
- `training/build_marshall_instruction_dataset.py` generates and validates deterministic train/valid/test/eval splits for Marshall coordinator-event tasks.
- `training/mlx_lora_eval.py` runs held-out generation checks against a base model or LoRA adapter and writes `eval.json` metrics.
- `MARSHALL_JOB_COUNT` lets the control CLI create multiple jobs in one run; `train_adapter` uses dataset shards for multi-worker claims.
- workers materialize only the assigned shard into a content-addressed cache under `.marshall/cache/datasets/<sha256>` before training.
- `training/build_ag_news_dataset.py` builds a local private AG News classification dataset under `.marshall/datasets/ag-news`, and `training/mlx_ag_news_eval.py` scores base-model or adapter exact-label accuracy.

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

## Development

Use Node.js 22 or newer.

```bash
nvm use
npm install
npm run build
npm run dataset:marshall:check
npm run dataset:ag-news:build
npm run dataset:ag-news:check
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

Dataset artifacts are private/local for now. The repository carries only the synthetic MIT Marshall structure-validation dataset; external datasets should stay outside the repo until license and distribution policy are reviewed.

## License

Marshall source code is MIT licensed. The project remains private for structure validation; external datasets and generated training artifacts are not published from this repository.
