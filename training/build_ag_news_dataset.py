#!/usr/bin/env python3
"""Build a local AG News classification dataset for Marshall adapter tests."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
import subprocess
import urllib.request
from pathlib import Path
from typing import Any


DATASET_ID = "ag-news-classification-v1"
DATASET_VERSION = "2026-06-29"
DATASET_SCHEMA = "mlx-chat-jsonl"
DATASET_LICENSE = "external-local-test"
DEFAULT_TRAIN_URL = "https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/train.csv"
DEFAULT_TEST_URL = "https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv"
DEFAULT_RAW_DIR = Path(".marshall/cache/raw/ag-news")
LABELS = {
    "1": "World",
    "2": "Sports",
    "3": "Business",
    "4": "Sci/Tech",
}
LABEL_ORDER = ["World", "Sports", "Business", "Sci/Tech"]
SPLIT_FILES = ["train.jsonl", "valid.jsonl", "test.jsonl", "eval.jsonl"]
SYSTEM_PROMPT = "Classify the news article. Return only one label: World, Sports, Business, Sci/Tech."


def main() -> None:
    args = parse_args()
    if args.check:
        validate_dataset(args.output_dir, args.shard_count)
        print(f"ag news dataset is current at {args.output_dir}")
        return

    raw_dir = args.raw_dir
    raw_dir.mkdir(parents=True, exist_ok=True)
    train_csv = download(args.train_url, raw_dir / "train.csv")
    test_csv = download(args.test_url, raw_dir / "test.csv")

    train_rows = read_csv(train_csv)
    test_rows = read_csv(test_csv)
    rng = random.Random(args.seed)
    rng.shuffle(train_rows)
    rng.shuffle(test_rows)

    needed_train = args.train_size + args.valid_size
    needed_test = args.test_size + args.eval_size
    if len(train_rows) < needed_train:
        raise ValueError(f"train source has {len(train_rows)} rows, need {needed_train}")
    if len(test_rows) < needed_test:
        raise ValueError(f"test source has {len(test_rows)} rows, need {needed_test}")

    records = {
        "train": train_rows[: args.train_size],
        "valid": train_rows[args.train_size:needed_train],
        "test": test_rows[: args.test_size],
        "eval": test_rows[args.test_size:needed_test],
    }
    write_dataset(args.output_dir, records, args.shard_count, args.train_url, args.test_url, args.seed)
    validate_dataset(args.output_dir, args.shard_count)
    print(
        "built ag news dataset "
        f"train={len(records['train'])}, valid={len(records['valid'])}, "
        f"test={len(records['test'])}, eval={len(records['eval'])}, shards={args.shard_count}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path(".marshall/datasets/ag-news"))
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR)
    parser.add_argument("--train-url", default=DEFAULT_TRAIN_URL)
    parser.add_argument("--test-url", default=DEFAULT_TEST_URL)
    parser.add_argument("--train-size", type=int, default=2000)
    parser.add_argument("--valid-size", type=int, default=400)
    parser.add_argument("--test-size", type=int, default=400)
    parser.add_argument("--eval-size", type=int, default=200)
    parser.add_argument("--shard-count", type=int, default=4)
    parser.add_argument("--seed", type=int, default=8821)
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def download(url: str, path: Path) -> Path:
    if path.exists() and path.stat().st_size > 0:
        return path
    temp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            temp_path.write_bytes(response.read())
    except Exception:
        subprocess.run(["curl", "-L", "--fail", "--silent", "--show-error", "-o", str(temp_path), url], check=True)
    temp_path.replace(path)
    return path


def read_csv(path: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    with path.open("r", encoding="utf8", newline="") as handle:
        reader = csv.reader(handle)
        for line_number, row in enumerate(reader, start=1):
            if len(row) != 3:
                raise ValueError(f"{path}:{line_number}: expected 3 CSV fields")
            label = LABELS.get(row[0])
            if label is None:
                raise ValueError(f"{path}:{line_number}: unknown label {row[0]}")
            title = normalize_space(row[1])
            description = normalize_space(row[2])
            if not title or not description:
                raise ValueError(f"{path}:{line_number}: empty title or description")
            rows.append({
                "label": label,
                "title": title,
                "description": description,
            })
    if not rows:
        raise ValueError(f"{path}: no rows")
    return rows


def write_dataset(
    output_dir: Path,
    records: dict[str, list[dict[str, str]]],
    shard_count: int,
    train_url: str,
    test_url: str,
    seed: int,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {
        "train.jsonl": to_train_jsonl(records["train"]),
        "valid.jsonl": to_train_jsonl(records["valid"]),
        "test.jsonl": to_train_jsonl(records["test"]),
        "eval.jsonl": to_eval_jsonl(records["eval"]),
    }

    train_shards = split_records(records["train"], shard_count)
    valid_shards = split_records(records["valid"], shard_count)
    if len(train_shards) != len(valid_shards):
        raise ValueError("train and validation shard counts differ")
    for index, (train_shard, valid_shard) in enumerate(zip(train_shards, valid_shards), start=1):
        shard_dir = f"shards/shard-{index:03d}"
        files[f"{shard_dir}/train.jsonl"] = to_train_jsonl(train_shard)
        files[f"{shard_dir}/valid.jsonl"] = to_train_jsonl(valid_shard)

    files["manifest.json"] = build_manifest(output_dir, files, shard_count, train_url, test_url, seed)
    for relative, content in files.items():
        path = output_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf8")


def build_manifest(
    output_dir: Path,
    files: dict[str, str],
    shard_count: int,
    train_url: str,
    test_url: str,
    seed: int,
) -> str:
    shards = []
    for index in range(1, shard_count + 1):
        shard_path = f"shards/shard-{index:03d}"
        shards.append({
            "shard_id": f"ag_news_shard_{index:03d}",
            "split": "train_valid",
            "uri": file_uri(output_dir / shard_path),
            "sha256": hash_split_files(files, [f"{shard_path}/train.jsonl", f"{shard_path}/valid.jsonl"]),
            "token_estimate": estimate_tokens([
                files[f"{shard_path}/train.jsonl"],
                files[f"{shard_path}/valid.jsonl"],
            ]),
        })

    manifest = {
        "dataset_id": DATASET_ID,
        "version": DATASET_VERSION,
        "license": DATASET_LICENSE,
        "visibility": "local-private-test",
        "schema": DATASET_SCHEMA,
        "root_uri": file_uri(output_dir),
        "root_hash": hash_split_files(files, SPLIT_FILES),
        "token_estimate": estimate_tokens([files[name] for name in SPLIT_FILES]),
        "source_urls": {
            "train": train_url,
            "test": test_url,
        },
        "sampling": {
            "seed": seed,
            "labels": LABEL_ORDER,
        },
        "notes": "Local AG News classification dataset for private Marshall adapter training and exact-label evaluation.",
        "shards": shards,
    }
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def to_train_jsonl(records: list[dict[str, str]]) -> str:
    return "".join(json.dumps({
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt_for(record)},
            {"role": "assistant", "content": record["label"]},
        ],
    }, separators=(",", ":"), ensure_ascii=False) + "\n" for record in records)


def to_eval_jsonl(records: list[dict[str, str]]) -> str:
    lines = []
    for index, record in enumerate(records, start=1):
        lines.append(json.dumps({
            "id": f"ag_news_eval_{index:06d}",
            "system": SYSTEM_PROMPT,
            "prompt": prompt_for(record),
            "expected_label": record["label"],
            "labels": LABEL_ORDER,
            "title": record["title"],
        }, separators=(",", ":"), ensure_ascii=False))
    return "\n".join(lines) + "\n"


def prompt_for(record: dict[str, str]) -> str:
    return f"Title: {record['title']}\nArticle: {record['description']}"


def split_records(records: list[dict[str, str]], shard_count: int) -> list[list[dict[str, str]]]:
    if shard_count < 1:
        raise ValueError("shard_count must be positive")
    shards = [[] for _ in range(shard_count)]
    for index, record in enumerate(records):
        shards[index % shard_count].append(record)
    return shards


def hash_split_files(files: dict[str, str], names: list[str]) -> str:
    digest = hashlib.sha256()
    for name in names:
        content = files[name].encode("utf8")
        digest.update(f"file\0{Path(name).name}\0{len(content)}\0".encode("utf8"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


def hash_split_paths(root: Path, names: list[str]) -> str:
    digest = hashlib.sha256()
    for name in names:
        content = (root / name).read_bytes()
        digest.update(f"file\0{Path(name).name}\0{len(content)}\0".encode("utf8"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


def validate_dataset(output_dir: Path, shard_count: int) -> None:
    manifest_path = output_dir / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"{manifest_path} does not exist; run without --check first")
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    if manifest.get("dataset_id") != DATASET_ID:
        raise ValueError(f"{manifest_path}: invalid dataset_id")
    if manifest.get("version") != DATASET_VERSION:
        raise ValueError(f"{manifest_path}: invalid version")
    if manifest.get("schema") != DATASET_SCHEMA:
        raise ValueError(f"{manifest_path}: invalid schema")
    if manifest.get("root_hash") != hash_split_paths(output_dir, SPLIT_FILES):
        raise ValueError(f"{manifest_path}: root_hash mismatch")

    for split in ["train", "valid", "test"]:
        validate_train_jsonl(output_dir / f"{split}.jsonl")
    validate_eval_jsonl(output_dir / "eval.jsonl")

    shards = manifest.get("shards")
    if not isinstance(shards, list) or len(shards) != shard_count:
        raise ValueError(f"{manifest_path}: expected {shard_count} shards")
    for index, shard in enumerate(shards, start=1):
        shard_dir = output_dir / "shards" / f"shard-{index:03d}"
        expected_hash = hash_split_paths(shard_dir, ["train.jsonl", "valid.jsonl"])
        if shard.get("sha256") != expected_hash:
            raise ValueError(f"{manifest_path}: shard {index} hash mismatch")
        validate_train_jsonl(shard_dir / "train.jsonl")
        validate_train_jsonl(shard_dir / "valid.jsonl")


def validate_train_jsonl(path: Path) -> None:
    count = 0
    with path.open("r", encoding="utf8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            messages = record.get("messages")
            if not isinstance(messages, list) or len(messages) != 3:
                raise ValueError(f"{path}:{line_number}: expected 3 chat messages")
            if messages[-1].get("content") not in LABEL_ORDER:
                raise ValueError(f"{path}:{line_number}: invalid label")
            count += 1
    if count == 0:
        raise ValueError(f"{path}: no records")


def validate_eval_jsonl(path: Path) -> None:
    count = 0
    with path.open("r", encoding="utf8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("expected_label") not in LABEL_ORDER:
                raise ValueError(f"{path}:{line_number}: invalid expected_label")
            if not record.get("system") or not record.get("prompt"):
                raise ValueError(f"{path}:{line_number}: missing system or prompt")
            count += 1
    if count == 0:
        raise ValueError(f"{path}: no records")


def estimate_tokens(contents: list[str]) -> int:
    words = 0
    for content in contents:
        words += len(re.findall(r"\S+", content))
    return max(1, int(words * 1.35))


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def file_uri(path: Path) -> str:
    return f"file://{path.as_posix()}"


if __name__ == "__main__":
    main()
