#!/usr/bin/env python3
"""Train and evaluate a lightweight AG News multinomial Naive Bayes classifier."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


LABELS = ["World", "Sports", "Business", "Sci/Tech"]
TOKEN_RE = re.compile(r"[a-z0-9]+")


def main() -> None:
    args = parse_args()
    if args.command == "train":
        train(args)
    elif args.command == "eval":
        evaluate(args)
    else:
        raise SystemExit(f"unsupported command: {args.command}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)

    train_parser = subcommands.add_parser("train")
    train_parser.add_argument("--dataset-dir", type=Path, required=True)
    train_parser.add_argument("--output-dir", type=Path, required=True)
    train_parser.add_argument("--job-id", required=True)
    train_parser.add_argument("--run-id", required=True)
    train_parser.add_argument("--round-id", required=True)
    train_parser.add_argument("--alpha", type=float, default=1.0)

    eval_parser = subcommands.add_parser("eval")
    eval_parser.add_argument("--model-path", type=Path, required=True)
    eval_parser.add_argument("--eval-file", type=Path, required=True)
    eval_parser.add_argument("--output-dir", type=Path, required=True)
    eval_parser.add_argument("--max-examples", type=int, default=80)
    eval_parser.add_argument("--fail-under", type=float)

    return parser.parse_args()


def train(args: argparse.Namespace) -> None:
    records = read_training_records(args.dataset_dir / "train.jsonl")
    class_docs = Counter()
    class_tokens: dict[str, Counter[str]] = {label: Counter() for label in LABELS}
    class_token_totals = Counter()
    vocab: set[str] = set()

    for record in records:
        label = record["label"]
        tokens = tokenize(record["text"])
        class_docs[label] += 1
        class_tokens[label].update(tokens)
        class_token_totals[label] += len(tokens)
        vocab.update(tokens)

    model = {
        "type": "marshall_ag_news_naive_bayes",
        "job_id": args.job_id,
        "run_id": args.run_id,
        "round_id": args.round_id,
        "labels": LABELS,
        "alpha": args.alpha,
        "examples": len(records),
        "vocab_size": len(vocab),
        "class_docs": dict(class_docs),
        "class_token_totals": dict(class_token_totals),
        "class_tokens": {label: dict(tokens) for label, tokens in class_tokens.items()},
    }

    args.output_dir.mkdir(parents=True, exist_ok=True)
    model_path = args.output_dir / "model.json"
    metrics_path = args.output_dir / "metrics.json"
    model_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n", encoding="utf8")

    metrics = {
        "job_id": args.job_id,
        "run_id": args.run_id,
        "round_id": args.round_id,
        "model": "ag_news_naive_bayes",
        "dataset": str(args.dataset_dir),
        "examples": len(records),
        "labels": LABELS,
        "vocab_size": len(vocab),
        "alpha": args.alpha,
        "model_path": str(model_path),
    }
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf8")
    print(json.dumps(metrics, indent=2))


def evaluate(args: argparse.Namespace) -> None:
    model = json.loads(args.model_path.read_text(encoding="utf8"))
    records = read_eval_records(args.eval_file)
    selected = records[: args.max_examples] if args.max_examples else records
    results = []
    for record in selected:
        predicted = predict(model, record["prompt"])
        expected = record["expected_label"]
        results.append({
            "id": record["id"],
            "expected_label": expected,
            "predicted_label": predicted,
            "correct": predicted == expected,
            "output": predicted,
        })

    correct = sum(1 for result in results if result["correct"])
    invalid = sum(1 for result in results if result["predicted_label"] not in LABELS)
    metrics = {
        "model": "ag_news_naive_bayes",
        "model_path": str(args.model_path),
        "eval_file": str(args.eval_file),
        "examples": len(results),
        "correct": correct,
        "accuracy": correct / len(results),
        "invalid": invalid,
        "invalid_rate": invalid / len(results),
        "labels": LABELS,
        "results": results,
    }

    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_path = args.output_dir / "eval.json"
    output_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf8")
    print(json.dumps(metrics, indent=2))

    if args.fail_under is not None and metrics["accuracy"] < args.fail_under:
        raise SystemExit(f"accuracy {metrics['accuracy']:.3f} is below {args.fail_under:.3f}")


def predict(model: dict[str, Any], text: str) -> str:
    tokens = tokenize(text)
    labels = model["labels"]
    alpha = float(model["alpha"])
    total_docs = sum(int(model["class_docs"].get(label, 0)) for label in labels)
    vocab_size = int(model["vocab_size"])

    scores = {}
    for label in labels:
        docs = int(model["class_docs"].get(label, 0))
        token_total = int(model["class_token_totals"].get(label, 0))
        token_counts = model["class_tokens"].get(label, {})
        score = math.log((docs + alpha) / (total_docs + alpha * len(labels)))
        denominator = token_total + alpha * max(vocab_size, 1)
        for token in tokens:
            count = int(token_counts.get(token, 0))
            score += math.log((count + alpha) / denominator)
        scores[label] = score

    return max(labels, key=lambda label: scores[label])


def read_training_records(path: Path) -> list[dict[str, str]]:
    records = []
    with path.open("r", encoding="utf8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            item = json.loads(line)
            messages = item.get("messages")
            if not isinstance(messages, list) or len(messages) < 3:
                raise ValueError(f"{path}:{line_number}: invalid messages")
            text = str(messages[1].get("content", ""))
            label = str(messages[2].get("content", ""))
            if label not in LABELS:
                raise ValueError(f"{path}:{line_number}: invalid label {label}")
            records.append({"text": text, "label": label})
    if not records:
        raise ValueError(f"{path} has no records")
    return records


def read_eval_records(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open("r", encoding="utf8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            for key in ["id", "prompt", "expected_label"]:
                if key not in record:
                    raise ValueError(f"{path}:{line_number}: missing {key}")
            if record["expected_label"] not in LABELS:
                raise ValueError(f"{path}:{line_number}: invalid expected_label")
            records.append(record)
    if not records:
        raise ValueError(f"{path} has no eval records")
    return records


def tokenize(value: str) -> list[str]:
    return TOKEN_RE.findall(value.lower())


if __name__ == "__main__":
    main()
