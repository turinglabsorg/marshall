#!/usr/bin/env python3
"""Train a tiny character bigram language model with stdlib-only SGD."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path


def read_texts(path: Path) -> list[str]:
    texts: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            item = json.loads(line)
            text = str(item["text"]).strip()
            if text:
                texts.append(text)
    if not texts:
        raise ValueError(f"dataset has no text rows: {path}")
    return texts


def make_pairs(texts: list[str], stoi: dict[str, int]) -> list[tuple[int, int]]:
    pairs: list[tuple[int, int]] = []
    for text in texts:
        sequence = "\n" + text + "\n"
        for left, right in zip(sequence, sequence[1:]):
            pairs.append((stoi[left], stoi[right]))
    return pairs


def softmax(logits: list[float]) -> list[float]:
    highest = max(logits)
    exps = [math.exp(value - highest) for value in logits]
    total = sum(exps)
    return [value / total for value in exps]


def average_loss(weights: list[list[float]], pairs: list[tuple[int, int]]) -> float:
    total = 0.0
    for left, right in pairs:
        probs = softmax(weights[left])
        total += -math.log(max(probs[right], 1e-12))
    return total / len(pairs)


def train(weights: list[list[float]], pairs: list[tuple[int, int]], epochs: int, learning_rate: float) -> None:
    for _ in range(epochs):
        for left, right in pairs:
            probs = softmax(weights[left])
            row = weights[left]
            for idx, prob in enumerate(probs):
                gradient = prob - (1.0 if idx == right else 0.0)
                row[idx] -= learning_rate * gradient


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--learning-rate", type=float, default=0.35)
    args = parser.parse_args()

    dataset_path = Path(args.dataset).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    texts = read_texts(dataset_path)
    vocab = sorted(set("\n".join(texts) + "\n"))
    stoi = {char: idx for idx, char in enumerate(vocab)}
    pairs = make_pairs(texts, stoi)
    weights = [[0.0 for _ in vocab] for _ in vocab]

    loss_start = average_loss(weights, pairs)
    train(weights, pairs, args.epochs, args.learning_rate)
    loss_end = average_loss(weights, pairs)

    model_path = output_dir / "model.json"
    metrics_path = output_dir / "metrics.json"
    log_path = output_dir / "train.log"
    manifest_path = output_dir / "manifest.json"

    model = {
        "model_type": "character_bigram",
        "vocab": vocab,
        "weights": weights,
    }
    model_path.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    metrics = {
        "job_id": args.job_id,
        "dataset": str(dataset_path),
        "examples": len(texts),
        "tokens": len(pairs),
        "vocab_size": len(vocab),
        "epochs": args.epochs,
        "learning_rate": args.learning_rate,
        "loss_start": loss_start,
        "loss_end": loss_end,
        "loss_delta": loss_start - loss_end,
    }
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    log_path.write_text(
        f"job={args.job_id}\nloss_start={loss_start:.6f}\nloss_end={loss_end:.6f}\n",
        encoding="utf-8",
    )

    config_hash = hashlib.sha256(
        json.dumps(
            {
                "dataset_hash": sha256(dataset_path),
                "epochs": args.epochs,
                "learning_rate": args.learning_rate,
                "model_type": "character_bigram",
            },
            sort_keys=True,
        ).encode("utf-8"),
    ).hexdigest()

    manifest = {
        "job_id": args.job_id,
        "artifact_type": "toy_language_model",
        "artifact_uri": model_path.as_uri(),
        "artifact_hash": sha256(model_path),
        "config_hash": f"sha256:{config_hash}",
        "metrics_uri": metrics_path.as_uri(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest_path), "metrics": metrics}, indent=2))


if __name__ == "__main__":
    main()
