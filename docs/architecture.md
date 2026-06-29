# Marshall Architecture

## System Shape

Marshall coordinates asynchronous AI jobs across heterogeneous consumer hardware. Workers do not synchronize on training steps. They receive bounded jobs, produce artifacts, and the coordinator validates those artifacts before using them in later rounds.

The network starts p2p-first. The coordinator is the scheduling authority in the MVP, but it is also a libp2p control peer. Workers join the network through libp2p discovery, maintain signed peer identities, claim jobs over protocol streams, and publish artifact manifests back to the control peer.

```text
Dashboard / CLI
      |
Coordinator / Control Peer ---- Job Queue
      |                 |
  Scheduler          libp2p Network
      |                 |
Bootstrap/Relay ---- Workers: mlx, cuda, cpu
                        |
                Artifact Registry
                        |
              Validation + Reputation
```

## Components

### Coordinator / Control Peer

Responsibilities:

- create runs and rounds;
- act as the first libp2p bootstrap/rendezvous peer;
- register workers through signed libp2p messages;
- store worker capabilities;
- assign jobs;
- track job state;
- accept artifact manifests;
- trigger validation;
- trigger adapter merges;
- publish next-round artifacts.

Initial stack:

- FastAPI for admin/dashboard APIs;
- SQLite;
- local filesystem artifact storage;
- TypeScript libp2p control peer for worker connectivity.

Scale path:

- Postgres;
- Redis or NATS for coordinator internals;
- S3-compatible object storage;
- dedicated libp2p relay nodes;
- Prometheus/Grafana.

### P2P Network

The p2p layer uses libp2p from the first implementation milestone.

Required MVP features:

- persistent Ed25519 peer identity per worker;
- bootstrap peer list in config;
- local mDNS discovery for same-LAN development;
- identify and ping services;
- direct request/response streams for worker registration, job claims, status updates, and artifact manifests;
- gossipsub for low-value network announcements;
- relay support for NAT-constrained workers.

Initial protocols:

```text
/marshall/worker/register/1.0.0
/marshall/worker/heartbeat/1.0.0
/marshall/job/offer/1.0.0
/marshall/job/claim/1.0.0
/marshall/job/status/1.0.0
/marshall/artifact/manifest/1.0.0
```

### Worker Daemon

Responsibilities:

- own a persistent libp2p peer identity;
- benchmark local hardware;
- discover the control peer;
- register capabilities;
- claim jobs over p2p streams;
- download models and dataset shards;
- execute the assigned backend task;
- publish artifact manifests;
- report metrics and failures;
- retry safely when jobs are idempotent.

The worker should be split into a libp2p peer process and backend runners. The first backend runner is MLX on Apple Silicon.

```text
worker peer (TypeScript/libp2p)
  -> local runner adapter
  -> Python MLX training script
```

Initial worker backends:

- `mlx` for Apple Silicon LoRA and evaluation;
- `cpu` for cleaning, tokenization, and metadata validation.

CUDA support should be added after the MLX loop is stable.

### Scheduler

The scheduler assigns work based on:

- backend support;
- measured throughput;
- memory;
- current queue depth;
- worker reliability;
- dataset shard size;
- model size;
- job deadline;
- artifact priority.

Rules:

- fast workers receive larger shards;
- slow workers receive smaller jobs;
- unreliable workers receive non-critical jobs;
- CPU-only workers do preprocessing;
- no round waits for every worker;
- every job must be retryable or safely marked failed.

### Artifact Registry

Every job produces a content-addressed artifact:

- LoRA adapters;
- training logs;
- evaluation reports;
- cleaned shards;
- tokenized shards;
- benchmark reports;
- run manifests.

Required metadata:

- content hash;
- producer peer ID;
- producer worker ID;
- job ID;
- run ID;
- round ID;
- creation timestamp;
- config hash;
- validation status.

### Validation

Validation gates all contributions before merge or reputation updates.

Checks:

- artifact format;
- model compatibility;
- LoRA config compatibility;
- dataset shard assignment;
- token count plausibility;
- training log sanity;
- hidden evaluation score;
- baseline regression;
- duplicate or corrupted upload detection;
- peer/worker identity consistency.

### Reputation

Reputation is an internal scheduling signal first, not a public reward system.

Signals:

- accepted artifacts;
- rejected artifacts;
- completion rate;
- timeout rate;
- eval contribution;
- throughput consistency;
- hardware honesty;
- failure recovery.

## Core Data Model

Minimum tables:

- `workers`;
- `worker_capabilities`;
- `peer_identities`;
- `runs`;
- `rounds`;
- `jobs`;
- `artifacts`;
- `evaluations`;
- `merges`;
- `dataset_shards`;
- `reputation_events`.

## Network Surface

The first worker network API is libp2p. HTTP endpoints are admin/dev conveniences and should not be the only path workers can use.

### libp2p Protocol Surface

```text
/marshall/worker/register/1.0.0
/marshall/worker/heartbeat/1.0.0
/marshall/job/offer/1.0.0
/marshall/job/claim/1.0.0
/marshall/job/status/1.0.0
/marshall/artifact/manifest/1.0.0
```

### HTTP Admin Surface

```http
POST /runs
POST /runs/{run_id}/rounds
GET /workers
GET /jobs
GET /artifacts
```

The first end-to-end loop must work through libp2p.
