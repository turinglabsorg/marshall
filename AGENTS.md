# Marshall Agent Notes

Marshall is a p2p-first consumer AI compute network for asynchronous AI workloads.

## Architecture Direction

- Use libp2p from the first implementation milestone.
- The coordinator is a control peer, not only an HTTP service.
- Workers are libp2p peers with persistent Ed25519 identities.
- Worker registration, job claim, job status, heartbeat, and artifact manifests must work over libp2p streams.
- HTTP endpoints are admin/debug/dashboard conveniences, not the primary worker network.
- Start permissioned: unknown peers must not receive trusted jobs.

## Initial Stack

- Node.js 22+ runtime for current js-libp2p dependencies.
- TypeScript libp2p for the p2p substrate.
- Python MLX runner for Apple Silicon LoRA jobs.
- FastAPI for coordinator admin APIs.
- SQLite for MVP metadata.
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
- `src/control-peer.ts` implements the in-memory control peer and handlers for worker registration, heartbeat, job claim, job status, and artifact manifests.
- `src/worker-peer.ts` implements a worker peer that dials the control peer and drives the first job lifecycle.
- `src/schemas.ts` defines Zod schemas for worker registration, heartbeat, job claim, `TrainAdapterJob`, job status, artifact manifest, and ACK payloads.
- `tests/p2p.integration.test.ts` starts real libp2p peers on localhost and verifies the full first lifecycle.

## Verification

Use Node.js 22+.

```bash
nvm use
npm run typecheck
npm test
npm run demo:compiled
```

The p2p integration test opens real TCP sockets on `127.0.0.1`, so sandboxed agents may need escalated execution for test/runtime commands.

## Development Rules

- Keep all docs in English.
- Do not add blockchain, token, payment, or incentive code before validation and reputation work.
- Do not build synchronous distributed training.
- Do not assume all workers are equally capable.
- Runtime-test networking changes with at least one control peer and one worker peer before marking them done.
- For backend/API functions, add integration tests.
