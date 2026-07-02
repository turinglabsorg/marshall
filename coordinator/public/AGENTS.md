# Marshall Worker Instructions

You are joining Marshall as a permissionless Mac worker.

Marshall is a permissionless distributed training network. The public training surface is `https://marshall.training`. `marshall.chat` is reserved for future model chat and inference demos.

Repository: `https://github.com/turinglabsorg/marshall`

There is no worker join token for the public swarm. Do not set `MARSHALL_SWARM_TOKEN` and do not pass `--swarm-token`.

## What Your Mac Will Do

Your Mac connects to the public Marshall control peer over libp2p, registers its hardware capability, claims compatible jobs, downloads only the assigned dataset shard or artifact files, verifies every declared SHA-256 hash and byte size, trains/evaluates/validates locally, then publishes artifact manifests back to the swarm. Worker pools are long-running by default and keep polling for new compatible jobs.

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
Do not change `--key-dir` while reusing the same `--worker-id-prefix`: the coordinator binds each worker id to its libp2p peer key and rejects mismatches to prevent identity takeover.

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

## Fetch the Live Control Network

The public control network is published by Marshall at runtime. Fetch it before starting a worker:

```sh
export MARSHALL_CONTROL_NETWORK_URL="https://marshall.training/control-network.json"
node -e "fetch(process.env.MARSHALL_CONTROL_NETWORK_URL).then(r => r.json()).then(j => console.log(j.peers.map(p => p.control_addr).join('\\n')))"
```

The values should look like:

```text
/dns4/marshall.training/tcp/4001/p2p/<control-peer-id>
/dns4/marshall.training/tcp/4002/p2p/<mirror-peer-id>
```

## Join Available Work

Run the model worker supervisor. A model worker is one persistent worker pool that can train adapters, evaluate adapters, and validate artifacts. Inference workers are a separate future role because they keep a selected model package hot for chat traffic.

```sh
npm run worker:join:compiled -- \
  --control-network-url "$MARSHALL_CONTROL_NETWORK_URL" \
  --worker-id-base "$(hostname)" \
  --state-dir .marshall/public-worker \
  --model-concurrency 2 \
  --slot-memory-gb 16 \
  --memory-gb 32 \
  --python "$MARSHALL_PYTHON"
```

Keep this process running. When one job finishes, the same model worker slot immediately asks for more compatible work across training, evaluation, and validation. Keep `--model-concurrency` low until you know the machine has enough memory for parallel MLX runs.
For later restarts, keep the same `--worker-id-base` and `--state-dir` if you want to preserve the same worker identities and reputation.
Set `--memory-gb` to the real unified memory or RAM available to the worker. Some jobs declare `resource_requirements.min_memory_gb`; workers below that threshold stay idle and should not claim the job.
Set `--slot-memory-gb` to the memory budget per concurrent slot; the pool caps concurrency against `--memory-gb`.
Validation uses worker alternation. If the active policy requires quorum 2, the swarm needs at least two compatible validator identities that are not the artifact producer/evaluator. Extra low-memory slots can help validate CPU-only jobs while memory gates keep them away from high-memory training and evaluation work.

If you intentionally want to run only one role for debugging, use `npm run worker:pool:compiled` with an explicit `--job-type`, separate `--worker-id-prefix`, `--key-dir`, and role-specific cache/artifact directories.

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

If the dashboard shows no compatible queued jobs, worker pools stay idle and poll again automatically. If you intentionally want a one-shot maintenance run, pass `--max-jobs <n> --exit-when-idle` to `worker:pool:compiled`; do not use those flags for normal public participation.

## Worker Rules

- Do not set a swarm token for the public permissionless swarm.
- Claim jobs only through `npm run worker:join:compiled`, `npm run worker:pool:compiled`, or `npm run worker:start:compiled`.
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
curl -fsS https://marshall.training/control-network.json
nc -vz marshall.training 4001
nc -vz marshall.training 4002
```

If MLX import fails, reactivate the venv and reinstall:

```sh
source "$HOME/.marshall/mlx-venv/bin/activate"
python -m pip install --upgrade mlx mlx-lm numpy
```

If a dataset hash check fails, delete only your local worker dataset cache and retry:

```sh
rm -rf .marshall/public-worker/*/dataset-cache
```
