# Marshall Coordinator

The coordinator is the authoritative runtime state for the MVP.

It is native Go and uses Redis for speed and operational simplicity:

- Redis hashes/sets hold derived state for runs, workers, jobs, claims, and artifacts;
- Redis Streams hold the append-only event log;
- Redis Lua makes job claims atomic.

The DHT/p2p layer should be used for discovery, routing, and artifact provider lookup. Redis-backed coordinator state remains the source of truth for job ownership, lifecycle transitions, artifact acceptance, and round advancement.

The TypeScript libp2p control peer can be configured with `coordinatorUrl`. In that mode it still speaks the p2p protocols to workers, but persists run/job initialization, worker registration, job claims, job statuses, and artifact manifests through the Go coordinator HTTP API.

When the control peer creates jobs it sends the full `MarshallJob` payload as `job_spec`. Redis keeps this alongside the derived job fields, so `evaluate_adapter` jobs retain their adapter reference, eval shard hash, model, and evaluation limits as coordinator state.

## Runtime

```bash
docker run --rm -p 6379:6379 redis:7-alpine
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go run ./cmd/marshall-coordinator
```

Environment:

```text
MARSHALL_HTTP_ADDR=127.0.0.1:8080
MARSHALL_REDIS_ADDR=127.0.0.1:6379
MARSHALL_REDIS_PREFIX=marshall
```

## HTTP Surface

```text
GET  /health
POST /runs
POST /workers
POST /jobs
GET  /jobs/{job_id}
POST /jobs/{job_id}/claim
POST /jobs/{job_id}/status
POST /artifacts
GET  /artifacts/{job_id}
POST /artifacts/{job_id}/verdict
GET  /workers/{worker_id}/reputation
GET  /events?count=100
```

## Event Types

```text
run_created
worker_registered
job_created
job_claimed
job_status_updated
artifact_published
artifact_verdict_vote_recorded
artifact_verdict_recorded
worker_reputation_updated
validator_reputation_updated
```

Validator verdicts require a registered, active validator worker with `validate_artifact` support. For quorum-based validation, the coordinator stores per-validator votes first and finalizes only when a verdict reaches quorum. Finalization updates the target worker reputation and scores validators based on whether their vote matched the final verdict. The HTTP verdict response includes `validator_reputations` when validator scoring occurs.

## Redis Keys

```text
marshall:events
marshall:runs
marshall:workers
marshall:jobs
marshall:artifacts
marshall:run:<run_id>
marshall:run:<run_id>:jobs
marshall:worker:<worker_id>
marshall:job:<job_id>
marshall:job:<job_id>:lease
marshall:artifact:<job_id>
```

## Testing

Compile-only and skipped Redis integration:

```bash
go test ./...
```

Runtime integration against real Redis:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
MARSHALL_REDIS_ADDR=127.0.0.1:6379 go test ./...
```

End-to-end p2p bridge test against a running coordinator:

```bash
MARSHALL_REDIS_ADDR=127.0.0.1:6379 MARSHALL_HTTP_ADDR=127.0.0.1:8080 go run ./cmd/marshall-coordinator
MARSHALL_COORDINATOR_URL=http://127.0.0.1:8080 npm test
```

Full AG News product E2E against the coordinator:

```bash
MARSHALL_REDIS_ADDR=127.0.0.1:6379 MARSHALL_HTTP_ADDR=127.0.0.1:8080 go run ./cmd/marshall-coordinator
npm run e2e:ag-news:compiled -- \
  --coordinator-url http://127.0.0.1:8080 \
  --python ~/.marshall/mlx-venv/bin/python
```

The runner performs train, evaluate, leaderboard/package, and query validation. When `--coordinator-url` is set it also verifies that train and eval jobs reached `completed` state and that their artifacts are readable from the coordinator API.

## Control And Worker CLI

The TypeScript runtime can now be started as separate processes.

Control peer:

```bash
MARSHALL_COORDINATOR_URL=http://127.0.0.1:8080 \
MARSHALL_CONTROL_LISTEN=/ip4/0.0.0.0/tcp/4001 \
MARSHALL_JOB_TYPE=train_mlx_smoke \
npm run control:start
```

Worker:

```bash
MARSHALL_PYTHON=~/.marshall/mlx-venv/bin/python \
npm run worker:start -- \
  --control /ip4/<host>/tcp/4001/p2p/<control-peer-id> \
  --job-type train_mlx_smoke \
  --backend mlx \
  --worker-id macbook-mlx-01
```
