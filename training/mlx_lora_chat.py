#!/usr/bin/env python3
"""Run one Marshall chat turn against an MLX-LM base model and optional LoRA adapter."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path


def main() -> None:
    args = parse_args()
    started_at = time.time()
    command = generate_command() + [
        "--model",
        args.model,
        "--system-prompt",
        args.system_prompt,
        "--prompt",
        args.prompt,
        "--max-tokens",
        str(args.max_tokens),
        "--temp",
        str(args.temp),
        "--verbose",
        "False",
    ]
    if args.adapter_path is not None:
        command.extend(["--adapter-path", str(args.adapter_path)])

    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise SystemExit(json.dumps({
            "type": "marshall_chat_error",
            "error": completed.stderr.strip() or completed.stdout.strip() or f"mlx_lm.generate exited {completed.returncode}",
        }))

    raw_output = clean_generate_output(completed.stdout)
    text = clean_chat_text(raw_output)
    elapsed_ms = int((time.time() - started_at) * 1000)
    print(json.dumps({
        "type": "marshall_chat_completion",
        "model": args.model,
        "adapter_path": str(args.adapter_path) if args.adapter_path else None,
        "prompt": args.prompt,
        "text": text,
        "raw_text": raw_output,
        "elapsed_ms": elapsed_ms,
    }, ensure_ascii=False))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter-path", type=Path)
    parser.add_argument("--system-prompt", default="You are Marshall, a concise helpful assistant.")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-tokens", type=int, default=160)
    parser.add_argument("--temp", type=float, default=0.2)
    return parser.parse_args()


def generate_command() -> list[str]:
    executable = shutil.which("mlx_lm.generate")
    if executable:
        return [executable]

    venv_executable = Path(sys.executable).parent / "mlx_lm.generate"
    if venv_executable.exists():
        return [str(venv_executable)]

    return [sys.executable, "-m", "mlx_lm.generate"]


def clean_generate_output(output: str) -> str:
    lines = [
        line for line in output.splitlines()
        if not line.startswith("Calling `python -m mlx_lm.generate")
    ]
    return "\n".join(lines).strip()


def clean_chat_text(output: str) -> str:
    text = output
    stop_markers = ["<end_of_turn>", "<eos>", "</s>"]
    for marker in stop_markers:
        marker_index = text.find(marker)
        if marker_index != -1:
            text = text[:marker_index]
    text = text.replace("<pad>", " ")
    text = re.sub(r"<\|[^>]+?\|>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


if __name__ == "__main__":
    main()
