#!/usr/bin/env python3
"""Evaluate a base model or LoRA adapter on AG News exact-label accuracy."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


LABELS = ["World", "Sports", "Business", "Sci/Tech"]


def main() -> None:
    args = parse_args()
    records = read_eval_records(args.eval_file)
    selected = records[: args.max_examples] if args.max_examples else records
    args.output_dir.mkdir(parents=True, exist_ok=True)

    results = [run_case(args, record) for record in selected]
    correct = sum(1 for result in results if result["correct"])
    invalid = sum(1 for result in results if result["predicted_label"] is None)
    metrics = {
        "model": args.model,
        "adapter_path": str(args.adapter_path) if args.adapter_path else None,
        "eval_file": str(args.eval_file),
        "examples": len(results),
        "correct": correct,
        "accuracy": correct / len(results),
        "invalid": invalid,
        "invalid_rate": invalid / len(results),
        "labels": LABELS,
        "results": results,
    }

    output_path = args.output_dir / "eval.json"
    output_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf8")
    print(json.dumps(metrics, indent=2))

    if args.fail_under is not None and metrics["accuracy"] < args.fail_under:
        raise SystemExit(f"accuracy {metrics['accuracy']:.3f} is below {args.fail_under:.3f}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval-file", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model", default="mlx-community/Qwen2.5-0.5B-Instruct-4bit")
    parser.add_argument("--adapter-path", type=Path)
    parser.add_argument("--max-examples", type=int, default=80)
    parser.add_argument("--max-tokens", type=int, default=8)
    parser.add_argument("--temp", type=float, default=0.0)
    parser.add_argument("--fail-under", type=float)
    return parser.parse_args()


def run_case(args: argparse.Namespace, record: dict[str, Any]) -> dict[str, Any]:
    command = generate_command() + [
        "--model",
        args.model,
        "--system-prompt",
        record["system"],
        "--prompt",
        record["prompt"],
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
        raise RuntimeError(f"mlx_lm.generate exited with code {completed.returncode}\n{completed.stderr}")

    output = clean_generate_output(completed.stdout)
    predicted = extract_label(output)
    expected = record["expected_label"]
    return {
        "id": record["id"],
        "expected_label": expected,
        "predicted_label": predicted,
        "correct": predicted == expected,
        "output": output,
    }


def generate_command() -> list[str]:
    executable = shutil.which("mlx_lm.generate")
    if executable:
        return [executable]

    venv_executable = Path(sys.executable).parent / "mlx_lm.generate"
    if venv_executable.exists():
        return [str(venv_executable)]

    return [sys.executable, "-m", "mlx_lm.generate"]


def read_eval_records(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open("r", encoding="utf8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            for key in ["id", "system", "prompt", "expected_label"]:
                if key not in record:
                    raise ValueError(f"{path}:{line_number}: missing {key}")
            if record["expected_label"] not in LABELS:
                raise ValueError(f"{path}:{line_number}: invalid expected_label")
            records.append(record)
    if not records:
        raise ValueError(f"{path} has no eval records")
    return records


def extract_label(output: str) -> str | None:
    normalized = normalize(output)
    if not normalized:
        return None

    first_line = output.strip().splitlines()[0].strip().rstrip(".:")
    for label in LABELS:
        if first_line.lower() == label.lower():
            return label

    candidates = []
    if re.search(r"\bworld\b", normalized):
        candidates.append("World")
    if re.search(r"\bsports?\b", normalized):
        candidates.append("Sports")
    if re.search(r"\bbusiness\b", normalized):
        candidates.append("Business")
    if "sci tech" in normalized or "science technology" in normalized or re.search(r"\btech(nology)?\b", normalized):
        candidates.append("Sci/Tech")

    unique = list(dict.fromkeys(candidates))
    if len(unique) == 1:
        return unique[0]
    return None


def clean_generate_output(output: str) -> str:
    lines = [
        line for line in output.splitlines()
        if not line.startswith("Calling `python -m mlx_lm.generate")
    ]
    return "\n".join(lines).strip()


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", value.lower())).strip()


if __name__ == "__main__":
    main()
