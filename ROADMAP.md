# Marshall Roadmap

Marshall is a permissionless distributed training and inference network. The near-term goal is to prove useful work end to end: workers join without a token, claim real jobs, train or serve bounded workloads, publish verifiable artifacts, and build reputation from validated output.

## Product Direction

Marshall should scale as a network of heterogeneous workers, not as a fake single GPU cluster. The system should support three execution modes:

- asynchronous adapter training;
- distributed evaluation and validation;
- replicated distributed inference.

Synchronous full-model training and sharded single-request inference are future cluster modes, not the public permissionless default.

## Phase 1: Reliable Public Training Loop

Status: in progress.

Goals:

- keep `marshall.training` online as the public training network surface;
- publish worker-resolvable jobs through `/control.json`;
- keep Redis private to the coordinator host;
- keep worker onboarding permissionless;
- train real LoRA adapters from content-addressed dataset shards;
- validate every artifact before it can affect model selection;
- keep stale workers hidden from the live dashboard while preserving identity and reputation;
- make every transfer hash-verified before downstream work consumes it.

Required work:

- automated job publication from a run manifest;
- public run status grouped by dataset, base model, round, and shard;
- retry and requeue automation for expired jobs;
- validator job creation from unvalidated artifacts;
- accepted-only leaderboard and model package publication;
- documented operator workflow for starting a new public run.

## Phase 2: Larger-Parameter Fine-Tuning

Marshall should first scale model size through LoRA and QLoRA-style adapter jobs. The base model remains frozen, each worker trains a bounded adapter on assigned data, and the coordinator validates, ranks, and packages accepted adapters.

Target progression:

- 0.5B models for fast public smoke tests;
- 1.5B to 3B models for realistic Apple Silicon worker trials;
- 7B to 8B quantized models for serious adapter quality tests;
- 14B+ models only for high-memory workers with explicit capability declarations.

Job specs must carry all training-critical choices:

- base model identifier;
- quantization format;
- adapter method;
- adapter rank and alpha;
- target modules;
- sequence length;
- batch size and accumulation;
- learning rate and schedule;
- train/eval split;
- minimum memory and backend requirements;
- expected artifact schema.

Workers must not choose these values locally. They may reject a job if their hardware cannot satisfy the declared requirements.

## Phase 3: Round-Based Adapter Selection

Marshall-native scaling comes from many independent adapters and strong selection, not from pretending that every public worker participates in one synchronous optimizer step.

The round loop should be:

1. create dataset shards and training jobs;
2. assign jobs to workers by capability and reputation;
3. collect LoRA adapter artifacts;
4. evaluate adapters on held-out data;
5. create validator jobs for evaluation artifacts;
6. finalize accepted artifacts by quorum;
7. rank accepted adapters;
8. package the selected model or adapter set;
9. publish the next round.

Initial merge mode can remain `single_adapter`. Future merge modes may include weighted adapter averaging, task-specific adapter routing, or mixture-of-adapters, but only after evaluation proves that merged output beats the best single accepted adapter.

## Phase 4: Replicated Distributed Inference

`marshall.chat` now has a P2P inference prototype: an HTTP gateway can route a prompt to one or more libp2p inference workers running the selected model package.

It also has durable gateway-owned conversation memory. The gateway persists `conversation_id`, message history, model package metadata, and a summary field under `.marshall/chat/conversations`, then sends only a bounded context window to the selected worker. Inference workers must remain stateless for privacy and routing resilience; a conversation can move between workers because the gateway carries the context.

The gateway now probes configured workers with `/marshall/inference/hello/1.0.0`, filters for the requested model and adapter, exposes a public worker registry endpoint without raw multiaddrs, and retries compatible workers when generation fails.

The next product step is a replicated inference gateway with streamed responses.

Workers advertise loaded models and adapters. A router receives a prompt, selects one capable worker, forwards the request, streams tokens back, and records runtime metrics.

Routing signals:

- model and adapter availability;
- worker reputation;
- current queue depth;
- time to first token;
- tokens per second;
- recent failure rate;
- memory headroom;
- geographic or network latency when available.

This scales throughput by adding workers. It does not split one forward pass across random public machines.

Implemented prototype protocol:

- `/marshall/inference/hello/1.0.0` for worker capability probes;
- `/marshall/inference/generate/1.0.0` for gateway-to-worker generation requests.

Required production protocols:

- `serve_model` worker registration capability;
- model cache manifest publication;
- inference request and streamed response protocol;
- inference benchmark jobs;
- timeout and retry policy with reputation-aware scoring;
- output audit logs with hashes and model package identifiers.

Long-term memory roadmap:

- summary compaction when message history exceeds the context budget;
- semantic memory retrieval scoped by conversation and user;
- encrypted or private-store persistence for hosted `marshall.chat`;
- sticky routing as an optimization only, never as the source of conversational truth;
- explicit user controls for memory reset, export, and retention.

## Phase 5: Trusted Cluster Modes

Full fine-tuning and sharded single-request inference require tight synchronization, high bandwidth, low jitter, and compatible accelerators. These should be represented as trusted cluster jobs with explicit topology, not as permissionless public worker jobs.

When a model is too large for one worker, Marshall can support it only by treating multiple machines as one declared cluster. The cluster must expose its topology before scheduling starts: number of nodes, accelerators per node, memory per accelerator, network class, backend, model cache paths, and supported parallelism strategy.

Possible future cluster modes:

- FSDP or ZeRO-style full fine-tuning;
- tensor parallel inference;
- pipeline parallel inference;
- multi-node evaluator clusters;
- dedicated GPU worker pools.

Model splitting strategies:

- tensor parallelism splits large matrix operations across accelerators and requires frequent high-bandwidth communication;
- pipeline parallelism splits model layers across accelerators or nodes and passes activations through the pipeline;
- FSDP or ZeRO-style training shards model parameters, gradients, and optimizer state across workers during training;
- replicated serving keeps a full model copy on each capable worker and load-balances requests, which remains the default public-swarm inference path.

Cluster workers should still use Marshall identity, scheduling, artifact, and reputation contracts, but the scheduler must treat the cluster as a bounded resource group with its own health checks and topology constraints.

## Non-Goals For The Public Swarm

- no synchronous optimizer steps across public Internet workers;
- no single user inference request split across arbitrary permissionless workers;
- no worker-chosen model or dataset overrides for public jobs;
- no unvalidated artifact entering model selection;
- no deletion of reputation records just because a worker is stale in the dashboard.

## Next Implementation Steps

1. Add richer worker capability reports for memory, backend, model cache, and measured throughput.
2. Extend `TrainingJob.training_config` with adapter rank, alpha, target modules, quantization, and minimum memory.
3. Add scheduler filtering by declared model requirements.
4. Run a 1.5B or 3B adapter job with the current public job flow.
5. Add automatic evaluation and validator job generation after training artifacts appear.
6. Add a model package endpoint for the best accepted adapter.
7. Add `serve_model` worker registration against the coordinator, including model package, queue depth, and live throughput.
8. Add router selection across multiple inference workers instead of an explicit `--p2p-worker-addr`.
9. Promote the gateway to `marshall.chat` after model package quality is validated.
