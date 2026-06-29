# Marshall Backlog

## Milestone 0: Contracts

- Define JSON schemas for worker registration.
- Define JSON schema for `TrainAdapterJob`.
- Define JSON schema for artifact manifests.
- Define run and round state transitions.
- Define failure reason codes.
- Define libp2p protocol names and payload schemas.
- Define worker peer identity format.

## Milestone 1: P2P Substrate

- Create TypeScript libp2p control peer.
- Create TypeScript libp2p worker peer.
- Add persistent Ed25519 peer identity.
- Add bootstrap peer config.
- Add local mDNS discovery for development.
- Add ping/identify health checks.
- Add relay support for NAT-constrained workers.
- Add `/marshall/worker/register/1.0.0`.
- Add `/marshall/worker/heartbeat/1.0.0`.
- Add `/marshall/job/claim/1.0.0`.
- Add `/marshall/job/status/1.0.0`.
- Add `/marshall/artifact/manifest/1.0.0`.

## Milestone 2: Local MLX Baseline

- Add a stdlib-only toy character language model trainer for fast local smoke tests.
- Select a TinyLlama-class base model.
- Prepare a small Italian JSONL shard.
- Run local MLX LoRA training on one Mac.
- Emit adapter, metrics, logs, and manifest.
- Add a merge script.
- Add an evaluation script.

## Milestone 3: Coordinator

- Create native Go coordinator daemon.
- Add Redis-backed state store.
- Add Redis Streams append-only event log.
- Add atomic Redis job claim leases.
- Store libp2p worker registrations.
- Store job claims and status updates.
- Store artifact manifests.
- Add run and round creation.
- Add HTTP admin endpoints for local debugging.

## Milestone 4: Worker Daemon

- Add worker identity file.
- Add capability benchmark.
- Add libp2p coordinator registration.
- Add job claim loop.
- Add model and shard download/cache.
- Add MLX job runner.
- Add artifact manifest publication.

## Milestone 5: Validation

- Validate artifact hash.
- Validate manifest schema.
- Validate model and LoRA config compatibility.
- Validate token count plausibility.
- Validate training log sanity.
- Validate peer identity consistency.
- Run hidden evaluation.
- Mark artifacts accepted or rejected.

## Milestone 6: Round Loop

- Merge accepted adapters.
- Evaluate merged adapter.
- Create next round from the merged artifact.
- Track accepted tokens and artifact quality.
- Add basic reputation events.

## Milestone 7: Private Multi-Machine Test

- Deploy coordinator on a stable host.
- Deploy a public libp2p bootstrap/relay peer.
- Connect 3 Apple Silicon workers.
- Run repeated rounds.
- Add retries and timeouts.
- Add local model cache.
- Add status dashboard or CLI.

## Later

- CUDA backend.
- S3-compatible artifact storage.
- Postgres.
- Queue backend.
- Signed worker artifacts.
- Duplicate high-value validation jobs.
- Public run manifests.
- Incentive accounting.
