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
  docs/
    architecture.md
    p2p.md
    mvp.md
    backlog.md
```

The implementation should start with the libp2p substrate and the MVP contracts in `docs/mvp.md`.
