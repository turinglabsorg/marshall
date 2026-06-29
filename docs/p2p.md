# Marshall P2P Network

Marshall uses libp2p from the first milestone. The coordinator is a control peer, not just an HTTP server. Workers are libp2p peers with persistent identities and signed messages.

## Implementation Choice

Use TypeScript libp2p for the initial p2p substrate.

Reasons:

- mature libp2p support;
- easier protocol iteration than Python libp2p;
- good fit with existing AgentLab tooling;
- worker MLX runners can remain Python processes invoked by the worker peer.

Runtime:

- Node.js 22 or newer is required for current js-libp2p dependencies.

The first worker process can be:

```text
worker peer (TypeScript/libp2p)
  -> local runner adapter
  -> Python MLX training script
```

## Network Roles

### Control Peer

The control peer:

- bootstraps the network;
- accepts worker registration;
- stores worker capabilities;
- offers jobs;
- receives job status;
- receives artifact manifests;
- triggers validation and merge work.

### Worker Peer

The worker peer:

- owns a persistent Ed25519 peer identity;
- discovers the control peer;
- registers capabilities;
- sends heartbeats;
- claims jobs;
- runs local backend tasks;
- publishes artifact manifests.

### Relay Peer

The relay peer:

- helps NAT-constrained workers connect;
- can be colocated with the control peer in the MVP;
- should become separable before a larger private test.

## Discovery

MVP discovery:

- static bootstrap multiaddrs in config;
- mDNS for local same-LAN development.

Next step:

- relay reservations for NAT-constrained workers;
- optional rendezvous protocol;
- DHT only after the private network is stable.

## Protocols

```text
/marshall/worker/register/1.0.0
/marshall/worker/heartbeat/1.0.0
/marshall/job/offer/1.0.0
/marshall/job/claim/1.0.0
/marshall/job/status/1.0.0
/marshall/artifact/manifest/1.0.0
```

Use length-prefixed JSON for MVP protocol payloads. Add protobuf only after the message contracts stop moving.

## Topics

Gossipsub topics are useful for announcements, not authoritative scheduling.

Initial topics:

```text
marshall.network.announcements.v1
marshall.runs.<run_id>.events.v1
marshall.workers.heartbeats.v1
```

Job assignment and artifact manifests should use direct streams because they affect scheduler and validation state.

## Security

MVP security requirements:

- persistent worker Ed25519 identity;
- peer ID stored in worker registration;
- all artifact manifests include producer peer ID and worker ID;
- coordinator verifies that status and artifact messages come from the registered peer;
- workers never trust arbitrary job offers from unknown peers.

Later:

- signed artifact manifests;
- signed job payloads;
- allowlisted bootstrap peers;
- remote attestation where available;
- duplicate validation for high-value artifacts.

## Local Development Topology

```text
control peer
  /ip4/127.0.0.1/tcp/4001

worker peer 1
worker peer 2
worker peer 3
```

All workers can run on one machine for the first integration test. The second test should use three real Macs on the same LAN. The third test should put one worker behind NAT and connect through relay.
