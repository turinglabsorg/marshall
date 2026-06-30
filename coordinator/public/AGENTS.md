# Marshall Worker Instructions

You are joining a Marshall training and inference swarm as a worker agent.

## Objective

Connect to the Marshall control peer, claim compatible jobs from the coordinator-backed swarm, execute them locally, and publish artifacts back through the worker protocol. Do not invent results and do not manually edit artifacts.

## Requirements

- Node.js 22 or newer
- A local checkout of the Marshall repository
- `npm ci` completed in the repository
- For Apple Silicon MLX jobs: an MLX-capable Python environment and `MARSHALL_PYTHON` pointing to it
- A libp2p control multiaddr from the swarm operator
- A swarm token from the swarm operator

## Environment

Set these values before starting a worker:

```sh
export MARSHALL_CONTROL_ADDR="/ip4/<host>/tcp/<port>/p2p/<peer-id>"
export MARSHALL_SWARM_TOKEN="<worker-join-token>"
export MARSHALL_PYTHON="$HOME/.marshall/mlx-venv/bin/python"
```

## Build

```sh
npm ci
npm run build
```

## Join Evaluation or Inference Work

Use one worker per local accelerator until the operator says otherwise.

```sh
npm run worker:pool:compiled -- \
  --control "$MARSHALL_CONTROL_ADDR" \
  --job-type evaluate_adapter \
  --backend mlx \
  --swarm-token "$MARSHALL_SWARM_TOKEN" \
  --concurrency 1 \
  --max-jobs 1 \
  --job-lease-seconds 300 \
  --heartbeat-interval-ms 15000 \
  --worker-id-prefix "$(hostname)-marshall-eval" \
  --key-dir .marshall/worker-keys/eval \
  --artifacts-dir .marshall/worker-artifacts/eval \
  --dataset-cache-dir .marshall/worker-cache/eval \
  --python "$MARSHALL_PYTHON"
```

## Join Training Work

Only run training jobs when the operator has published compatible dataset shards.

```sh
npm run worker:pool:compiled -- \
  --control "$MARSHALL_CONTROL_ADDR" \
  --job-type train_adapter \
  --backend mlx \
  --swarm-token "$MARSHALL_SWARM_TOKEN" \
  --concurrency 1 \
  --max-jobs 1 \
  --job-lease-seconds 300 \
  --heartbeat-interval-ms 15000 \
  --worker-id-prefix "$(hostname)-marshall-train" \
  --key-dir .marshall/worker-keys/train \
  --artifacts-dir .marshall/worker-artifacts/train \
  --dataset-cache-dir .marshall/worker-cache/train \
  --python "$MARSHALL_PYTHON"
```

## Worker Rules

- Claim jobs through the worker command only.
- Publish artifacts through the worker protocol only.
- Keep heartbeat enabled while working; the coordinator can requeue jobs whose lease expires.
- Keep generated data under `.marshall/`; do not commit local run artifacts.
- Do not change job specs, labels, metrics, hashes, or leaderboard files by hand.
- If a job fails, let the worker report the failure instead of fabricating output.
- Report the worker ID, backend, memory, and failure logs to the operator when debugging.

## What the Coordinator Shows

The public console exposes registered workers, busy workers, job status, artifact hashes, and recent events. It does not prove model quality by itself; quality is established by evaluation artifacts, leaderboard ranking, and package/query verification.
