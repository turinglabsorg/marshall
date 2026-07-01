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
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

import mlx.core as mx


TRAIN_LOSS_RE = re.compile(r"train\s+loss\s+([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
VAL_LOSS_RE = re.compile(r"val\s+loss\s+([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
ITER_RE = re.compile(r"\b(?:iter|iteration)\s*[:=]?\s*([0-9]+)(?:\s*/\s*([0-9]+))?", re.IGNORECASE)
THROUGHPUT_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(?:it/s|iter/s|iters/s|iterations/s)", re.IGNORECASE)
PROGRESS_PREFIX = "MARSHALL_PROGRESS "


@dataclass
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str


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
        "--steps-per-report",
        str(args.steps_per_report),
        "--steps-per-eval",
        str(args.steps_per_eval),
        "--val-batches",
        str(args.val_batches),
        "--seed",
        str(args.seed),
    ]
    if args.mask_prompt:
        command.append("--mask-prompt")
    if args.grad_checkpoint:
        command.append("--grad-checkpoint")

    env = os.environ.copy()
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    stdout_path = output_dir / "mlx_lm_stdout.log"
    stderr_path = output_dir / "mlx_lm_stderr.log"
    completed = run_streaming_process(
        command,
        cwd=output_dir,
        env=env,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        total_iters=args.iters,
    )

    if completed.returncode != 0:
        raise RuntimeError(
            f"mlx_lm.lora exited with code {completed.returncode}\n"
            f"stderr tail:\n{tail(completed.stderr)}"
        )

    artifact_files = collect_artifact_files(adapter_dir)
    if not artifact_files:
        raise RuntimeError(f"mlx_lm.lora produced no adapter files in {adapter_dir}")

    output = completed.stdout + "\n" + completed.stderr
    train_losses = parse_losses(TRAIN_LOSS_RE, output)
    val_losses = parse_losses(VAL_LOSS_RE, output)
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
        "steps_per_report": args.steps_per_report,
        "steps_per_eval": args.steps_per_eval,
        "val_batches": args.val_batches,
        "seed": args.seed,
        "mask_prompt": args.mask_prompt,
        "grad_checkpoint": args.grad_checkpoint,
        "artifact_files": artifact_files,
        "stdout_log": str(stdout_path),
        "stderr_log": str(stderr_path),
    }
    if train_losses:
        metrics["train_loss_start"] = train_losses[0]
        metrics["train_loss_end"] = train_losses[-1]
        metrics["train_loss_delta"] = train_losses[0] - train_losses[-1]
    if val_losses:
        metrics["val_loss_start"] = val_losses[0]
        metrics["val_loss_end"] = val_losses[-1]
        metrics["val_loss_delta"] = val_losses[0] - val_losses[-1]

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
    parser.add_argument("--steps-per-report", type=int, default=10)
    parser.add_argument("--steps-per-eval", type=int, default=20)
    parser.add_argument("--val-batches", type=int, default=-1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mask-prompt", action="store_true", default=True)
    parser.add_argument("--no-mask-prompt", action="store_false", dest="mask_prompt")
    parser.add_argument("--grad-checkpoint", action="store_true")
    return parser.parse_args()


def lora_command() -> list[str]:
    executable = shutil.which("mlx_lm.lora")
    if executable:
        return [executable]

    venv_executable = Path(sys.executable).parent / "mlx_lm.lora"
    if venv_executable.exists():
        return [str(venv_executable)]

    return [sys.executable, "-m", "mlx_lm.lora"]


def run_streaming_process(
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    stdout_path: Path,
    stderr_path: Path,
    total_iters: int,
) -> ProcessResult:
    started_at = time.monotonic()
    last_iter = 0
    lock = threading.Lock()
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
    )

    def pump(stream: TextIO | None, sink: TextIO, chunks: list[str]) -> None:
        nonlocal last_iter
        if stream is None:
            return
        try:
            for line in stream:
                sink.write(line)
                sink.flush()
                chunks.append(line)
                progress = progress_from_line(line, total_iters, started_at)
                if progress is None:
                    continue
                with lock:
                    iteration = int(progress["work_units_done"])
                    if iteration < last_iter:
                        continue
                    last_iter = iteration
                print(PROGRESS_PREFIX + json.dumps(progress, separators=(",", ":")), flush=True)
        finally:
            stream.close()

    with stdout_path.open("w", encoding="utf8") as stdout_file, stderr_path.open("w", encoding="utf8") as stderr_file:
        stdout_thread = threading.Thread(target=pump, args=(process.stdout, stdout_file, stdout_chunks), daemon=True)
        stderr_thread = threading.Thread(target=pump, args=(process.stderr, stderr_file, stderr_chunks), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        returncode = process.wait()
        stdout_thread.join()
        stderr_thread.join()

    return ProcessResult(
        returncode=returncode,
        stdout="".join(stdout_chunks),
        stderr="".join(stderr_chunks),
    )


def progress_from_line(line: str, total_iters: int, started_at: float) -> dict[str, Any] | None:
    match = ITER_RE.search(line)
    if match is None:
        return None
    iteration = int(match.group(1))
    if iteration <= 0:
        return None
    observed_total = int(match.group(2)) if match.group(2) is not None else total_iters
    total = max(total_iters, observed_total, iteration)
    elapsed = max(time.monotonic() - started_at, 0.001)
    throughput_match = THROUGHPUT_RE.search(line)
    throughput = float(throughput_match.group(1)) if throughput_match is not None else iteration / elapsed
    percent = max(0.0, min(100.0, (iteration / total) * 100.0))
    return {
        "progress_percent": percent,
        "progress_label": f"training {iteration}/{total} iters",
        "work_units_done": iteration,
        "work_units_total": total,
        "throughput_units_per_second": throughput,
        "throughput_label": "iters/s",
    }


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


def parse_losses(pattern: re.Pattern[str], output: str) -> list[float]:
    return [float(match.group(1)) for match in pattern.finditer(output)]


def tail(value: str, lines: int = 30) -> str:
    return "\n".join(value.splitlines()[-lines:])


if __name__ == "__main__":
    main()
