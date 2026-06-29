#!/usr/bin/env python3
"""Run a tiny MLX-LM LoRA training job and emit Marshall metrics as JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import mlx.core as mx


TRAIN_LOSS_RE = re.compile(r"train(?:ing)?\s+loss[:= ]+([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)


def main() -> None:
    args = parse_args()
    dataset_dir = args.dataset_dir.resolve()
    output_dir = args.output_dir.resolve()
    adapter_dir = output_dir / "adapters"
    output_dir.mkdir(parents=True, exist_ok=True)
    adapter_dir.mkdir(parents=True, exist_ok=True)

    train_path = dataset_dir / "train.jsonl"
    valid_path = dataset_dir / "valid.jsonl"
    train_examples = count_jsonl(train_path)
    valid_examples = count_jsonl(valid_path) if valid_path.exists() else 0

    command = lora_command() + [
        "--model",
        args.model,
        "--train",
        "--data",
        str(dataset_dir),
        "--adapter-path",
        str(adapter_dir),
        "--iters",
        str(args.iters),
        "--batch-size",
        str(args.batch_size),
        "--learning-rate",
        str(args.learning_rate),
        "--num-layers",
        str(args.num_layers),
        "--max-seq-length",
        str(args.max_seq_length),
    ]
    if args.mask_prompt:
        command.append("--mask-prompt")
    if args.grad_checkpoint:
        command.append("--grad-checkpoint")

    env = os.environ.copy()
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    completed = subprocess.run(
        command,
        cwd=output_dir,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    stdout_path = output_dir / "mlx_lm_stdout.log"
    stderr_path = output_dir / "mlx_lm_stderr.log"
    stdout_path.write_text(completed.stdout, encoding="utf8")
    stderr_path.write_text(completed.stderr, encoding="utf8")

    if completed.returncode != 0:
        raise RuntimeError(
            f"mlx_lm.lora exited with code {completed.returncode}\n"
            f"stderr tail:\n{tail(completed.stderr)}"
        )

    artifact_files = collect_artifact_files(adapter_dir)
    if not artifact_files:
        raise RuntimeError(f"mlx_lm.lora produced no adapter files in {adapter_dir}")

    losses = parse_train_losses(completed.stdout + "\n" + completed.stderr)
    metrics: dict[str, Any] = {
        "job_id": args.job_id,
        "run_id": args.run_id,
        "round_id": args.round_id,
        "backend": "mlx",
        "device": str(mx.default_device()),
        "model": args.model,
        "dataset": str(dataset_dir),
        "adapter_path": str(adapter_dir),
        "train_examples": train_examples,
        "valid_examples": valid_examples,
        "iters": args.iters,
        "batch_size": args.batch_size,
        "learning_rate": args.learning_rate,
        "num_layers": args.num_layers,
        "max_seq_length": args.max_seq_length,
        "mask_prompt": args.mask_prompt,
        "grad_checkpoint": args.grad_checkpoint,
        "artifact_files": artifact_files,
        "stdout_log": str(stdout_path),
        "stderr_log": str(stderr_path),
    }
    if losses:
        metrics["train_loss_start"] = losses[0]
        metrics["train_loss_end"] = losses[-1]
        metrics["train_loss_delta"] = losses[0] - losses[-1]

    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf8")
    print(json.dumps(metrics, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--round-id", required=True)
    parser.add_argument("--model", default="mlx-community/Qwen2.5-0.5B-Instruct-4bit")
    parser.add_argument("--iters", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--num-layers", type=int, default=4)
    parser.add_argument("--max-seq-length", type=int, default=512)
    parser.add_argument("--mask-prompt", action="store_true", default=True)
    parser.add_argument("--no-mask-prompt", action="store_false", dest="mask_prompt")
    parser.add_argument("--grad-checkpoint", action="store_true")
    return parser.parse_args()


def lora_command() -> list[str]:
    executable = shutil.which("mlx_lm.lora")
    if executable:
        return [executable]

    venv_executable = Path(sys.executable).resolve().parent / "mlx_lm.lora"
    if venv_executable.exists():
        return [str(venv_executable)]

    return [sys.executable, "-m", "mlx_lm.lora"]


def count_jsonl(path: Path) -> int:
    if not path.exists():
        raise FileNotFoundError(path)

    count = 0
    with path.open("r", encoding="utf8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSONL: {error}") from error
            count += 1
    if count == 0:
        raise ValueError(f"{path} has no examples")
    return count


def collect_artifact_files(adapter_dir: Path) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for path in sorted(adapter_dir.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(adapter_dir).as_posix()
        files.append({
            "path": relative,
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    return files


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def parse_train_losses(output: str) -> list[float]:
    return [float(match.group(1)) for match in TRAIN_LOSS_RE.finditer(output)]


def tail(value: str, lines: int = 30) -> str:
    return "\n".join(value.splitlines()[-lines:])


if __name__ == "__main__":
    main()
