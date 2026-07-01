# Marshall

Marshall is a permissionless training network for small language models.

It turns consumer machines into a verifiable LoRA worker swarm: Macs and GPUs join over libp2p, claim real dataset shards, fine-tune adapters, publish hash-checked artifacts, and earn or lose reputation through distributed validation.

Marshall is not trying to pretend that random public machines are one synchronous GPU cluster. The public network scales through many independent adapter jobs, evaluation jobs, validator quorum, leaderboard selection, and future replicated inference. Model-parallel training and sharded inference belong to trusted cluster mode, not the open swarm default.

## Live Network

- Training dashboard: <https://marshall.training>
- Public chat fallback: <https://marshall.training/chat/>
- Chat gateway target: <https://marshall.chat>
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
- React terminal-style public dashboard at `marshall.training`, served as static build assets by the Go coordinator;
- permissionless libp2p control peer on public TCP `4001`;
- public `/control.json` for worker discovery;
- public `/AGENTS.md` worker onboarding;
- TypeScript libp2p worker/control protocols;
- persistent Ed25519 worker identities;
- persistent worker pool CLI with stable concurrent slots;
- MLX LoRA training runner with live progress telemetry from observed MLX-LM iteration output;
- dataset manifest builder with HTTP/S shard URIs;
- dataset cache with file size and SHA-256 verification;
- chunked p2p artifact transfer with retry and final root hash checks;
- explicit adapter evaluation jobs (`eval_kind: ag_news` or `instruction_terms`) and validation jobs;
- quorum-based validator verdicts;
- worker reputation and suspension policy;
- accepted-only adapter leaderboard and model package path;
- round advancement CLI for evaluation scheduling, validation scheduling, accepted-only leaderboard selection, and verified model packaging;
- P2P `marshall.chat` gateway with streamed browser responses, gateway-owned durable conversation memory, and stateless libp2p inference workers;
- GCP small-VM deployment with Caddy HTTPS, local Redis, coordinator, and control peer services.

Not implemented yet:

- always-on round orchestration daemon from training to validation to next run;
- production DNS/TLS cutover and process supervision for the public `marshall.chat` gateway;
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
6. start `worker:join:compiled` or `worker:pool:compiled` with `--job-types train_adapter,evaluate_adapter,validate_artifact`;
7. let the worker download only assigned shards or artifacts, verify hashes, run the compatible phase, and publish the artifact.

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
  --job-types train_adapter,evaluate_adapter,validate_artifact \
  --backend mlx \
  --concurrency 1 \
  --dataset-cache-dir .marshall/cache/datasets \
  --memory-gb 32 \
  --python ~/.marshall/mlx-venv/bin/python
```

`worker:pool` is long-running by default: each stable worker slot claims another compatible job after completing the previous one. Use `--max-jobs <n>` and `--exit-when-idle` only for bounded local tests or maintenance runs.
Keep `--key-dir` stable when reusing the same `--worker-id-prefix`; the coordinator binds worker identity to the libp2p peer key and rejects mismatches.
Workers must report `--memory-gb` explicitly. The control peer rejects memory-gated jobs before claim when the registered worker memory is below the job's `resource_requirements.min_memory_gb`.

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
  --min-memory-gb 16 \
  --instruction-field instruction \
  --response-field response \
  --context-field context
```

For remote public workers, shard URIs must be worker-resolvable HTTP/S URLs and every file must carry a SHA-256 hash and optional byte size. Workers fail the job on hash or size mismatch.
`dataset:run:prepare` requires `--min-memory-gb` for adapter training jobs. Larger base models should raise this value so under-sized workers stay idle instead of claiming work they cannot finish.

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
  --max-tokens 80 \
  --min-memory-gb 16
```

Use `eval_kind ag_news` for exact-label AG News scoring and `eval_kind instruction_terms` for held-out instruction generation checks. The worker records the evaluation kind in the produced metrics artifact so leaderboard and validator stages can reason about what was measured.
Evaluation jobs that load the same base model should use the same memory gate as training, or a higher one if generation settings require it.

## Round Advancement

`round:advance` is the product path for moving a run forward without hand-writing downstream job files. It reads coordinator artifacts or an artifact snapshot, then performs the next eligible phase:

- schedules `evaluate_adapter` jobs from published `lora_adapter` artifacts;
- schedules quorum `validate_artifact` jobs from unvalidated `adapter_evaluation` artifacts;
- writes accepted-only leaderboard files and an optional verified model package after validation is finalized.

For unattended runs, use `round:daemon`. It polls live coordinator jobs/artifacts, waits for each phase to finish, writes filtered artifact snapshots for the active run, schedules evaluation and validation jobs, publishes validation top-up jobs when quorum votes are missing or tied, and writes the final leaderboard/model package after quorum verdicts are finalized. It is the operational path for public multi-Mac runs.

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
  --eval-min-memory-gb 16 \
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
  --eval-min-memory-gb <gb> \
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

Use `worker:join:compiled` for a Mac that should remain available across train, evaluation, and validation phases. It fetches `/control.json` and starts one persistent `model` worker pool whose slots can claim training, evaluation, or validation jobs as the run advances. Inference workers are separate because they keep selected model packages hot for chat traffic.

```bash
npm run worker:join:compiled -- \
  --control-url https://marshall.training/control.json \
  --worker-id-base "$(hostname)" \
  --state-dir .marshall/public-worker \
  --model-concurrency 2 \
  --slot-memory-gb 16 \
  --memory-gb 32 \
  --python "$MARSHALL_PYTHON"
```

Increase `--model-concurrency` only after confirming memory headroom on that Mac. `--slot-memory-gb` is the per-slot budget used to cap effective concurrency against `--memory-gb`. Keep the same `--worker-id-base` and `--state-dir` across restarts to preserve worker identity and reputation.

## P2P marshall.chat Prototype

`marshall.chat` should be tested as a distributed path: an HTTP gateway serves the UI, but generation is performed by a separate libp2p inference worker. A local-process gateway is still available for debugging, but it is not the product proof.

Start the inference worker on the machine that owns the model and adapter, for example an Apple Silicon MacBook:

```bash
npm run inference:worker -- \
  --key .marshall/inference-worker.key \
  --listen /ip4/0.0.0.0/tcp/8788 \
  --worker-id "$(hostname)-inference-0001" \
  --model mlx-community/gemma-3-1b-it-4bit \
  --adapter-id job_dolly_gemma3_1b_public_shard_007 \
  --adapter-path .marshall/input-artifacts/<worker-id>/job_dolly_gemma3_1b_public_shard_007/artifact \
  --adapter-hash sha256:<adapter-root-hash> \
  --python ~/.marshall/mlx-venv/bin/python
```

The worker prints libp2p multiaddrs. Start the gateway on the Mac Pro with one or more reachable worker addresses:

```bash
npm run chat:dev -- \
  --host 127.0.0.1 \
  --port 8787 \
  --runtime p2p_worker \
  --p2p-key .marshall/chat-gateway.key \
  --p2p-worker-addr "/ip4/<worker-ip>/tcp/8788/p2p/<worker-peer-id>" \
  --p2p-worker-addrs "/ip4/<second-worker-ip>/tcp/8788/p2p/<second-worker-peer-id>" \
  --p2p-max-attempts 3 \
  --conversation-dir .marshall/chat/conversations \
  --max-context-messages 18 \
  --model mlx-community/gemma-3-1b-it-4bit \
  --adapter-id job_dolly_gemma3_1b_public_shard_007 \
  --adapter-hash sha256:<adapter-root-hash>
```

Open `http://127.0.0.1:8787`. The gateway exposes `GET /api/health`, `GET /api/inference/workers`, `GET /api/conversation?conversation_id=<id>`, `POST /api/chat`, and streaming `POST /api/chat/stream`. The gateway probes workers with `/marshall/inference/hello/1.0.0`, filters for the requested model and adapter, routes `/marshall/inference/generate_stream/1.0.0` or `/marshall/inference/generate/1.0.0` to a ready worker, and retries another compatible worker when generation fails. `/api/chat` and `/api/chat/stream` store the user turn under a durable `conversation_id`, build the bounded context window, send the request over libp2p, store the assistant turn, and return the updated conversation plus the selected `worker_id` and `worker_peer_id`.

In the chat composer, `Enter` submits the prompt and `Shift+Enter` inserts a newline.

Conversation memory belongs to the gateway, not to inference workers. The current durable store is file-backed under `.marshall/chat/conversations` by default. Each conversation file contains message history plus structured long-term memory: `summary`, `facts`, `preferences`, `goals`, `open_tasks`, and `plans`. The browser UI can edit and persist this memory through `POST /api/conversation/memory`; `GET /api/conversation` returns it with the conversation. Workers stay stateless: they receive only a bounded prompt assembled by the gateway. Use `--conversation-ttl-days <n>` to expire old files, `--max-context-messages <n>` to cap recent turns, and `--max-memory-items <n>` to cap long-term memory items included in the worker prompt. Future memory should add automatic summarization, semantic retrieval, encryption, and retention controls in the gateway or a private memory service, while the coordinator remains limited to routing, worker capacity, reputation, and public job metadata.

For the current Mac Pro hosted prototype, use the operational scripts instead of hand-written tmux commands:

```bash
scripts/run-chat-gateway-local.sh
scripts/run-chat-tunnel-gcp.sh
```

Both scripts read required configuration from an ignored local env file, `.marshall/secrets/chat-gateway.env` by default, and fail fast when required values are missing. `scripts/run-chat-gateway-local.sh` requires Node.js 22+ and starts the P2P chat gateway from the compiled `dist/src/chat-server-cli.js`. `scripts/run-chat-tunnel-gcp.sh` keeps the VM-local `127.0.0.1:8787` port connected back to the Mac Pro gateway through a reverse SSH tunnel. On macOS, install or remove persistent user LaunchAgents with:

```bash
scripts/install-macos-chat-launchd.sh
scripts/uninstall-macos-chat-launchd.sh
```

The installer writes generated plists under `~/Library/LaunchAgents`, stores logs under `.marshall/logs`, and keeps both gateway and tunnel alive with `KeepAlive`.

Inference workers can use the same persistent macOS pattern. Create an ignored env file such as `.marshall/secrets/inference-worker.env` on the worker Mac:

```bash
MARSHALL_NODE_BIN=/absolute/path/to/node
MARSHALL_INFERENCE_KEY=.marshall/inference-worker.key
MARSHALL_INFERENCE_LISTEN=/ip4/0.0.0.0/tcp/8788
MARSHALL_INFERENCE_WORKER_ID=<stable-worker-id>
MARSHALL_PYTHON=/absolute/path/to/mlx-python
MARSHALL_MODEL_PACKAGE=.marshall/runs/<run-id>/model-package/model_package.json
```

Then install the worker LaunchAgent from that machine:

```bash
scripts/install-macos-inference-launchd.sh
```

`scripts/run-inference-worker-local.sh` starts the compiled `dist/src/inference-worker-cli.js`, validates Node.js 22+, requires an explicit worker id, key, listen address, Python binary, and either a model package or explicit model/adapter metadata. `scripts/uninstall-macos-inference-launchd.sh` removes the LaunchAgent. Keep the worker env file out of git; it is machine-local operational state.

For a single-process debugging run only:

```bash
npm run chat:dev -- \
  --host 127.0.0.1 \
  --port 8787 \
  --model-package .marshall/model-packages/<run-id>/model_package.json \
  --conversation-dir .marshall/chat/conversations \
  --python ~/.marshall/mlx-venv/bin/python
```

For a package whose adapter path is not valid on the current machine, pass explicit local values:

```bash
npm run chat:dev -- \
  --host 127.0.0.1 \
  --port 8787 \
  --model mlx-community/gemma-3-1b-it-4bit \
  --adapter-id job_dolly_gemma3_1b_public_shard_007 \
  --adapter-path .marshall/input-artifacts/<worker-id>/job_dolly_gemma3_1b_public_shard_007/artifact \
  --adapter-hash sha256:<adapter-root-hash> \
  --python ~/.marshall/mlx-venv/bin/python
```

## Public Deployment

The current public trial deploy target is a small GCP VM:

- project: `iconic-elevator-394020`;
- instance: `marshall-micro-1`;
- machine type: `e2-small` with a 2GB swapfile;
- domain: `marshall.training`;
- chat domain: `marshall.chat`;
- HTTPS proxy: Caddy;
- coordinator: Go service on `127.0.0.1:8080`;
- control peer: Node.js libp2p service on TCP `4001`, serving live coordinator jobs with `--coordinator-jobs true`;
- round daemon: optional Node.js service that starts when `/etc/marshall/round-daemon.env` exists and automatically advances the configured run from training to evaluation, validation, and selection;
- Redis: local-only on the VM.

Deploy:

```bash
./scripts/deploy-gcp-micro.sh
```

The deploy script builds the TypeScript runtime, React dashboard bundle, and Go coordinator, uploads systemd services, keeps Redis private, publishes Caddy HTTPS, and writes `/control.json` for permissionless worker discovery. The same Caddy config exposes the chat gateway in two ways: `https://marshall.training/chat/` as the public fallback path, and a `marshall.chat` vhost that reverse-proxies to `127.0.0.1:8787`. For the current prototype, the Mac Pro chat gateway can be exposed to the VM through a reverse SSH tunnel managed by `scripts/run-chat-tunnel-gcp.sh` or the macOS LaunchAgent installer. Public HTTPS for `marshall.chat` requires the domain A record to point at the VM static IP `34.148.63.131`, after which Caddy can issue the Let's Encrypt certificate automatically.

Use the public chat readiness check before calling inference operational:

```bash
scripts/check-chat-public.sh --url https://marshall.training/chat/ --expected-ip 34.148.63.131
scripts/check-chat-public.sh --url https://marshall.chat --expected-ip 34.148.63.131
```

The check verifies DNS, then pins `curl` to the expected IP to avoid stale local resolver caches while checking HTTPS health, a streamed P2P inference response, at least one ready worker, and that public `completed` SSE events do not expose the gateway-composed prompt or long-term memory context.

## Architecture

Core components:

- `cmd/marshall-coordinator`: native Go coordinator daemon;
- `coordinator/`: Redis-backed state, HTTP API, dashboard, reputation, validation votes;
- `coordinator/ui/`: React source for the public dashboard; `coordinator/public/` contains the static assets embedded by Go;
- `src/control-peer.ts`: libp2p control peer and worker protocol handlers;
- `src/worker-peer.ts`: worker registration, heartbeat, claim, status, and artifact publication;
- `src/worker-supervisor-cli.ts`: persistent model worker supervisor for train/eval/validation work;
- `src/inference-worker-cli.ts`: libp2p inference worker for selected model packages;
- `src/chat-server-cli.ts`: `marshall.chat` gateway with local debug and P2P worker runtimes;
- `src/chat-memory.ts`: file-backed conversation memory and structured long-term plans owned by the gateway;
- `scripts/run-chat-gateway-local.sh`: Mac Pro gateway runner backed by an ignored local env file;
- `scripts/run-chat-tunnel-gcp.sh`: reverse SSH tunnel runner from the GCP VM to the local gateway;
- `scripts/check-chat-public.sh`: public DNS/HTTPS/P2P readiness check for `marshall.training/chat` and `marshall.chat`;
- `scripts/install-macos-chat-launchd.sh`: macOS LaunchAgent installer for persistent gateway and tunnel processes;
- `scripts/run-inference-worker-local.sh`: macOS inference worker runner backed by an ignored local env file;
- `scripts/install-macos-inference-launchd.sh`: macOS LaunchAgent installer for persistent inference workers;
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
