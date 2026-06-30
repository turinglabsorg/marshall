# Marshall Worker Instructions

You are joining Marshall as a permissionless Mac worker.

Marshall is a permissionless distributed training network. The public training surface is `https://marshall.training`. `marshall.chat` is reserved for future model chat and inference demos.

Repository: `https://github.com/turinglabsorg/marshall`

There is no worker join token for the public swarm. Do not set `MARSHALL_SWARM_TOKEN` and do not pass `--swarm-token`.

## What Your Mac Will Do

Your Mac connects to the public Marshall control peer over libp2p, registers its hardware capability, claims one compatible job, downloads only the assigned dataset shard files, verifies every declared SHA-256 hash and byte size, trains the adapter locally, then publishes an artifact manifest back to the swarm.

The active job defines the base model, dataset shard, LoRA settings, and evaluation contract. Workers must not override those values locally unless the operator explicitly asks for a debugging run.

## Requirements

- Apple Silicon Mac for MLX training jobs
- macOS shell with `git`, `curl`, and `python3`
- Node.js 22 or newer
- A local checkout of the Marshall repository
- An MLX Python environment for training jobs

## Install Node.js 22

If you use `nvm`:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22
```

If you use Homebrew:

```sh
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

Verify:

```sh
node --version
npm --version
```

## Clone and Build Marshall

```sh
git clone https://github.com/turinglabsorg/marshall.git
cd marshall
npm ci
npm run build
```

Keep all generated worker state under `.marshall/`. Do not commit worker keys, datasets, adapters, logs, or artifacts.

## Install MLX for Apple Silicon Training

```sh
python3 -m venv "$HOME/.marshall/mlx-venv"
source "$HOME/.marshall/mlx-venv/bin/activate"
python -m pip install --upgrade pip
python -m pip install mlx mlx-lm numpy
export MARSHALL_PYTHON="$HOME/.marshall/mlx-venv/bin/python"
```

Verify:

```sh
"$MARSHALL_PYTHON" -c "import mlx.core; import mlx_lm; print('mlx ready')"
```

## Fetch the Live Control Peer

The public control peer is published by Marshall at runtime. Fetch it before starting a worker:

```sh
export MARSHALL_CONTROL_ADDR="$(node -e "fetch('https://marshall.training/control.json').then(r => r.json()).then(j => console.log(j.control_addr))")"
echo "$MARSHALL_CONTROL_ADDR"
```

The value should look like:

```text
/dns4/marshall.training/tcp/4001/p2p/<control-peer-id>
```

## Claim Available Training Work

Run one worker first. It will claim one compatible `train_adapter` job if work is available.

```sh
npm run worker:pool:compiled -- \
  --control "$MARSHALL_CONTROL_ADDR" \
  --job-type train_adapter \
  --backend mlx \
  --concurrency 1 \
  --max-jobs 1 \
  --job-lease-seconds 900 \
  --heartbeat-interval-ms 15000 \
  --worker-id-prefix "$(hostname)-marshall-train" \
  --key-dir .marshall/worker-keys/train \
  --artifacts-dir .marshall/worker-artifacts/train \
  --dataset-cache-dir .marshall/worker-cache/train \
  --python "$MARSHALL_PYTHON"
```

To let the same Mac process more than one job sequentially, increase `--max-jobs`. Keep `--concurrency 1` until you know the machine has enough memory for parallel MLX runs.

## Monitor Progress

Open:

```text
https://marshall.training
```

The dashboard shows recently active registered workers, busy workers, queued/running/completed jobs, artifact hashes, and the live coordinator event stream. Workers that stop sending heartbeats are hidden from the dashboard after roughly 15 minutes, but their identity and reputation records are not deleted.

You can also inspect raw coordinator state:

```sh
curl -fsS https://marshall.training/dashboard
curl -fsS https://marshall.training/events?count=20
```

## If There Is No Job

If the worker exits with `no job assigned`, it connected correctly but no compatible work was available at that moment. Leave the command ready and try again after the dashboard shows queued jobs.

## Worker Rules

- Do not set a swarm token for the public permissionless swarm.
- Claim jobs only through `npm run worker:pool:compiled` or `npm run worker:start:compiled`.
- Do not manually edit job specs, dataset files, artifact manifests, metrics, hashes, or leaderboard files.
- Do not download unassigned dataset shards.
- Keep heartbeat enabled while working; expired jobs can be requeued.
- Let failures be reported by the worker instead of fabricating output.
- Published artifacts are validated before they affect model selection.
- Poor, rejected, malicious, or timed-out work reduces worker reputation.
- Suspended workers cannot claim more jobs.

## Troubleshooting

If the worker cannot connect:

```sh
curl -fsS https://marshall.training/control.json
nc -vz marshall.training 4001
```

If MLX import fails, reactivate the venv and reinstall:

```sh
source "$HOME/.marshall/mlx-venv/bin/activate"
python -m pip install --upgrade mlx mlx-lm numpy
```

If a dataset hash check fails, delete only your local worker dataset cache and retry:

```sh
rm -rf .marshall/worker-cache/train
```
