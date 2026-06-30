#!/usr/bin/env python3
"""Build and validate the deterministic Marshall instruction dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from pathlib import Path
from typing import Any


SEED = 7727
SHARD_COUNT = 4
DATASET_ID = "marshall-ops-synthetic-v1"
DATASET_VERSION = "2026-06-29"
DATASET_LICENSE = "MIT"
DATASET_SCHEMA = "mlx-chat-jsonl"

SYSTEMS = {
    "summary": "You summarize Marshall coordinator events with concise operational language.",
    "state": "You classify Marshall job state from coordinator events.",
    "artifact": "You explain Marshall artifacts.",
    "worker": "You explain Marshall worker capability records.",
    "failure": "You diagnose Marshall training failures.",
    "action": "You identify the useful next Marshall action.",
    "normalize": "You normalize Marshall status updates.",
}

WORKERS = [
    ("macbook-mlx-01", "mlx", "apple_silicon"),
    ("macbook-mlx-02", "mlx", "apple_silicon"),
    ("studio-mlx-01", "mlx", "apple_silicon"),
    ("cpu-builder-01", "cpu", "generic_cpu"),
]

ERRORS = [
    ("ModuleNotFoundError: No module named 'mlx_lm'", "the worker Python environment is missing mlx-lm"),
    ("expected MLX GPU device, got Device(cpu, 0)", "the worker did not run on an Apple Silicon GPU device"),
    ("No such file or directory: train.jsonl", "the dataset directory is missing train.jsonl"),
    ("training process exited with code 1", "the local training process exited with code 1"),
    ("out of memory while allocating MLX graph", "the LoRA job exceeded available worker memory"),
    ("artifact manifest rejected: assigned worker mismatch", "the artifact was published by the wrong worker"),
]

ARTIFACTS = ["lora_adapter", "mlx_smoke_result", "toy_language_model"]


def main() -> None:
    args = parse_args()
    files = build_dataset_files()

    if args.check:
        mismatches = []
        for name, expected in files.items():
            path = args.output_dir / name
            actual = path.read_text(encoding="utf8") if path.exists() else None
            if actual != expected:
                mismatches.append(name)
        if mismatches:
            print(f"dataset files are stale: {', '.join(mismatches)}", file=sys.stderr)
            sys.exit(1)
        validate_files(args.output_dir)
        print("marshall instruction dataset is current")
        return

    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        path = args.output_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf8")
    validate_files(args.output_dir)
    print(f"wrote dataset to {args.output_dir}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path(".marshall/datasets/marshall-instructions"))
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def build_dataset_files() -> dict[str, str]:
    records = build_chat_records()
    random.Random(SEED).shuffle(records)

    train = records[:180]
    valid = records[180:210]
    test = records[210:240]
    eval_records = build_eval_records()

    files = {
        "train.jsonl": to_jsonl(train),
        "valid.jsonl": to_jsonl(valid),
        "test.jsonl": to_jsonl(test),
        "eval.jsonl": to_jsonl(eval_records),
    }
    train_shards = split_records(train, SHARD_COUNT)
    valid_shards = split_records(valid, SHARD_COUNT)
    for index, (train_shard, valid_shard) in enumerate(zip(train_shards, valid_shards), start=1):
        shard_dir = f"shards/shard-{index:03d}"
        files[f"{shard_dir}/train.jsonl"] = to_jsonl(train_shard)
        files[f"{shard_dir}/valid.jsonl"] = to_jsonl(valid_shard)
    files["manifest.json"] = build_manifest(files)

    return files


def build_chat_records() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index in range(1, 241):
        worker_id, backend, device = WORKERS[index % len(WORKERS)]
        run_id = f"run_{index:03d}"
        job_id = f"job_adapter_{index:03d}"
        round_id = f"round_{(index % 7) + 1:03d}"
        artifact = ARTIFACTS[index % len(ARTIFACTS)]
        mode = index % 10

        if mode == 0:
            records.append(chat(
                SYSTEMS["summary"],
                f"Run {run_id} events: run_created, job_created {job_id}, worker_registered {worker_id}, job_claimed, job_running, artifact_published {artifact}, job_completed.",
                f"Run {run_id} completed successfully. Worker {worker_id} claimed {job_id}, published a {artifact} artifact, and sent the completed status.",
            ))
        elif mode == 1:
            message, diagnosis = ERRORS[index % len(ERRORS)]
            records.append(chat(
                SYSTEMS["failure"],
                f"Job {job_id} in {run_id} failed on {worker_id}. Message: {message}.",
                f"{job_id} failed after it started on {worker_id}. The likely cause is that {diagnosis}.",
            ))
        elif mode == 2:
            records.append(chat(
                SYSTEMS["state"],
                f"Events for {job_id}: job_created, job_claimed by {worker_id}, job_running. No artifact_published or terminal status is present.",
                f"{job_id} is running on {worker_id}. Wait for an artifact_published event or a completed or failed status.",
            ))
        elif mode == 3:
            minutes = 15 + (index % 6) * 5
            records.append(chat(
                SYSTEMS["state"],
                f"Events for {job_id}: job_created, job_claimed by {worker_id}. The last heartbeat was {minutes} minutes ago and no final status arrived.",
                f"{job_id} may be stale. It was claimed by {worker_id}, but no recent heartbeat or terminal status arrived.",
            ))
        elif mode == 4:
            worker_summary = (
                f"{worker_id} is an Apple Silicon MLX worker. It can run MLX smoke checks and LoRA adapter training jobs."
                if backend == "mlx"
                else f"{worker_id} is a CPU worker. It should not claim MLX adapter training jobs."
            )
            records.append(chat(
                SYSTEMS["worker"],
                f"Run {run_id}: worker {worker_id} registered for {job_id} with backend={backend}, device_family={device}, supported_jobs=[train_mlx_smoke, train_adapter], memory_gb={16 + (index % 4) * 16}.",
                worker_summary,
            ))
        elif mode == 5:
            records.append(chat(
                SYSTEMS["artifact"],
                f"Artifact manifest: job_id={job_id} artifact_type=lora_adapter artifact_uri=file:///tmp/marshall/{job_id}/adapters artifact_hash=sha256:{index:064x} metrics_uri=file:///tmp/marshall/{job_id}/metrics.json.",
                f"{job_id} produced a LoRA adapter artifact. Validate the metrics file and run an inference check before accepting it.",
            ))
        elif mode == 6:
            records.append(chat(
                SYSTEMS["action"],
                f"Run {run_id} has a completed train_adapter job, one lora_adapter artifact, and validation has not run yet.",
                f"Run adapter inference and validation for {run_id}, then record the result as an evaluation artifact.",
            ))
        elif mode == 7:
            informal = [
                f"{run_id}: worker joined, took {job_id}, wrote adapters, then completed",
                f"{run_id}: the run exists and {job_id} exists but nobody picked it up",
                f"{run_id}: adapter for {job_id} produced metrics but no evaluation has happened",
                f"{run_id}: {job_id} was claimed by the mlx worker, still running, no final status yet",
            ][index % 4]
            normalized = [
                "Worker registered, claimed the adapter job, published the adapter artifact, and completed the job.",
                "The run is pending capacity. The job exists, but no worker has claimed it yet.",
                "The adapter artifact is available. Run validation and inference before accepting it.",
                "The adapter job is running on the MLX worker and has no terminal status yet.",
            ][index % 4]
            records.append(chat(SYSTEMS["normalize"], informal, normalized))
        elif mode == 8:
            records.append(chat(
                SYSTEMS["state"],
                f"Events for {job_id}: job_created only. No worker_registered event exists and no job_claimed event exists.",
                f"{job_id} is pending capacity because no worker has registered or claimed it yet.",
            ))
        else:
            records.append(chat(
                SYSTEMS["action"],
                f"A LoRA adapter path exists for {job_id}, but the artifact manifest has no metrics_uri.",
                f"Treat {job_id} as incomplete until the worker publishes a metrics_uri for validation.",
            ))

    return records


def build_eval_records() -> list[dict[str, Any]]:
    return [
        eval_record(
            "eval_completed_adapter",
            SYSTEMS["summary"],
            "Run run_eval_001 events: worker_registered macbook-mlx-01, job_claimed job_eval_001, job_running, artifact_published lora_adapter, job_completed.",
            "Run run_eval_001 completed successfully and produced a LoRA adapter artifact.",
            ["completed", "lora", "adapter", "artifact"],
            ["failed"],
        ),
        eval_record(
            "eval_missing_worker",
            SYSTEMS["state"],
            "Events for job_eval_002: job_created only. No worker_registered event exists.",
            "job_eval_002 is pending capacity because no worker has registered or claimed it.",
            ["pending", "worker", "claimed"],
            ["completed"],
        ),
        eval_record(
            "eval_mlx_missing",
            SYSTEMS["failure"],
            "Job job_eval_003 failed with message: ModuleNotFoundError: No module named 'mlx_lm'.",
            "job_eval_003 failed because mlx-lm is missing from the worker Python environment.",
            ["failed", "mlx-lm", "worker", "environment"],
            ["completed"],
        ),
        eval_record(
            "eval_wrong_device",
            SYSTEMS["failure"],
            "Job job_eval_004 failed with message: expected MLX GPU device, got Device(cpu, 0).",
            "job_eval_004 failed because the MLX job ran on CPU instead of the Apple Silicon GPU.",
            ["failed", "cpu", "gpu", "mlx"],
            ["completed"],
        ),
        eval_record(
            "eval_artifact_next",
            SYSTEMS["action"],
            "A train_adapter job completed and published metrics.json plus adapters.safetensors.",
            "Run inference and validation against the adapter, then record an evaluation artifact.",
            ["inference", "validation", "adapter", "evaluation"],
            ["pending capacity"],
        ),
        eval_record(
            "eval_stale_claim",
            SYSTEMS["state"],
            "Events for job_eval_006: job_created, job_claimed by macbook-mlx-02. Last heartbeat was 45 minutes ago and no terminal status arrived.",
            "job_eval_006 may be stale because it was claimed but no recent heartbeat or final status arrived.",
            ["stale", "heartbeat", "claimed"],
            ["completed"],
        ),
        eval_record(
            "eval_worker_capability",
            SYSTEMS["worker"],
            "Worker studio-mlx-01 registered with backend=mlx, device_family=apple_silicon, supported_jobs=[train_mlx_smoke, train_adapter].",
            "studio-mlx-01 is an Apple Silicon MLX worker that can run LoRA adapter training.",
            ["apple", "silicon", "mlx", "adapter"],
            ["cpu-only"],
        ),
        eval_record(
            "eval_manifest",
            SYSTEMS["artifact"],
            "Artifact manifest: job_id=job_eval_008 artifact_type=lora_adapter artifact_uri=file:///tmp/adapters artifact_hash=sha256:abc metrics_uri=file:///tmp/metrics.json.",
            "job_eval_008 produced a LoRA adapter artifact with a metrics file that can be validated.",
            ["lora", "adapter", "metrics", "validated"],
            ["failed"],
        ),
        eval_record(
            "eval_informal_complete",
            SYSTEMS["normalize"],
            "worker got online, took the adapter task, saved safetensors, then marked it done",
            "Worker registered, claimed the adapter job, published the adapter artifact, and completed the job.",
            ["worker", "claimed", "adapter", "completed"],
            ["failed"],
        ),
        eval_record(
            "eval_no_metrics",
            SYSTEMS["action"],
            "A LoRA adapter path exists, but the artifact manifest has no metrics_uri.",
            "Treat the artifact as incomplete until the worker publishes a metrics_uri for validation.",
            ["incomplete", "metrics", "validation"],
            ["completed successfully"],
        ),
        eval_record(
            "eval_redis_bridge",
            SYSTEMS["summary"],
            "Coordinator event log contains run_created, job_created, worker_registered, job_claimed, job_status running, artifact_published, job_status completed.",
            "The coordinator lifecycle completed and persisted the worker claim, artifact publication, and completed status.",
            ["coordinator", "completed", "artifact", "claim"],
            ["failed"],
        ),
        eval_record(
            "eval_dataset_error",
            SYSTEMS["failure"],
            "Job job_eval_012 failed with message: No such file or directory: train.jsonl.",
            "job_eval_012 failed because the dataset directory is invalid or missing train.jsonl.",
            ["failed", "dataset", "train.jsonl"],
            ["completed"],
        ),
    ]


def chat(system: str, user: str, assistant: str) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ],
    }


def eval_record(
    record_id: str,
    system: str,
    prompt: str,
    expected: str,
    required_terms: list[str],
    forbidden_terms: list[str],
) -> dict[str, Any]:
    return {
        "id": record_id,
        "system": system,
        "prompt": prompt,
        "expected": expected,
        "required_terms": required_terms,
        "forbidden_terms": forbidden_terms,
    }


def to_jsonl(records: list[dict[str, Any]]) -> str:
    return "".join(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n" for record in records)


def build_manifest(files: dict[str, str]) -> str:
    shards = []
    for index in range(1, SHARD_COUNT + 1):
        shard_path = f"shards/shard-{index:03d}"
        shards.append({
            "shard_id": f"marshall_instructions_shard_{index:03d}",
            "split": "train_valid",
            "uri": f"file://.marshall/datasets/marshall-instructions/{shard_path}",
            "sha256": hash_split_files(files, [f"{shard_path}/train.jsonl", f"{shard_path}/valid.jsonl"]),
            "token_estimate": 18_000,
        })

    manifest = {
        "dataset_id": DATASET_ID,
        "version": DATASET_VERSION,
        "license": DATASET_LICENSE,
        "visibility": "private-structure-validation",
        "schema": DATASET_SCHEMA,
        "root_hash": hash_split_files(files, ["train.jsonl", "valid.jsonl", "test.jsonl", "eval.jsonl"]),
        "notes": "Synthetic Marshall coordinator-event dataset for validating private worker, shard, cache, training, and evaluation flow. External datasets are intentionally excluded.",
        "shards": shards,
    }
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def hash_split_files(files: dict[str, str], names: list[str]) -> str:
    digest = hashlib.sha256()
    for name in names:
        content = files[name].encode("utf8")
        digest.update(f"file\0{Path(name).name}\0{len(content)}\0".encode("utf8"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


def split_records(records: list[dict[str, Any]], shard_count: int) -> list[list[dict[str, Any]]]:
    shards = [[] for _ in range(shard_count)]
    for index, record in enumerate(records):
        shards[index % shard_count].append(record)
    return shards


def validate_files(output_dir: Path) -> None:
    chat_prompts: set[str] = set()
    counts = {}
    for name, minimum in [("train.jsonl", 150), ("valid.jsonl", 30), ("test.jsonl", 30)]:
        path = output_dir / name
        records = read_jsonl(path)
        counts[name] = len(records)
        if len(records) < minimum:
            raise ValueError(f"{name} has {len(records)} records, expected at least {minimum}")
        for index, record in enumerate(records, start=1):
            validate_chat_record(path, index, record)
            prompt = record["messages"][1]["content"]
            if prompt in chat_prompts:
                raise ValueError(f"duplicate prompt across splits: {prompt}")
            chat_prompts.add(prompt)

    eval_records = read_jsonl(output_dir / "eval.jsonl")
    if len(eval_records) < 12:
        raise ValueError("eval.jsonl needs at least 12 records")
    for index, record in enumerate(eval_records, start=1):
        validate_eval_record(output_dir / "eval.jsonl", index, record, chat_prompts)
    validate_manifest(output_dir / "manifest.json")

    shard_train_prompts: set[str] = set()
    for shard_index in range(1, SHARD_COUNT + 1):
        shard_dir = output_dir / "shards" / f"shard-{shard_index:03d}"
        shard_train = read_jsonl(shard_dir / "train.jsonl")
        shard_valid = read_jsonl(shard_dir / "valid.jsonl")
        if not shard_train:
            raise ValueError(f"{shard_dir}/train.jsonl has no records")
        if not shard_valid:
            raise ValueError(f"{shard_dir}/valid.jsonl has no records")
        for path, records in [(shard_dir / "train.jsonl", shard_train), (shard_dir / "valid.jsonl", shard_valid)]:
            for record_index, record in enumerate(records, start=1):
                validate_chat_record(path, record_index, record)
        for record in shard_train:
            prompt = record["messages"][1]["content"]
            if prompt in shard_train_prompts:
                raise ValueError(f"duplicate train prompt across shards: {prompt}")
            shard_train_prompts.add(prompt)

    train_prompt_count = len(read_jsonl(output_dir / "train.jsonl"))
    if len(shard_train_prompts) != train_prompt_count:
        raise ValueError(f"shards cover {len(shard_train_prompts)} train prompts, expected {train_prompt_count}")

    print(
        "validated "
        + ", ".join(f"{name}={count}" for name, count in sorted(counts.items()))
        + f", eval.jsonl={len(eval_records)}, shards={SHARD_COUNT}"
    )


def validate_manifest(path: Path) -> None:
    manifest = json.loads(path.read_text(encoding="utf8"))
    if manifest.get("dataset_id") != DATASET_ID:
        raise ValueError(f"{path}: invalid dataset_id")
    if manifest.get("version") != DATASET_VERSION:
        raise ValueError(f"{path}: invalid version")
    if manifest.get("license") != DATASET_LICENSE:
        raise ValueError(f"{path}: invalid license")
    if manifest.get("schema") != DATASET_SCHEMA:
        raise ValueError(f"{path}: invalid schema")
    shards = manifest.get("shards")
    if not isinstance(shards, list) or len(shards) != SHARD_COUNT:
        raise ValueError(f"{path}: expected {SHARD_COUNT} shards")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open("r", encoding="utf8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {error}") from error
    return records


def validate_chat_record(path: Path, index: int, record: dict[str, Any]) -> None:
    messages = record.get("messages")
    if not isinstance(messages, list) or len(messages) != 3:
        raise ValueError(f"{path}:{index}: expected exactly three chat messages")
    for message, role in zip(messages, ["system", "user", "assistant"]):
        if message.get("role") != role:
            raise ValueError(f"{path}:{index}: expected role {role}")
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f"{path}:{index}: empty {role} content")


def validate_eval_record(path: Path, index: int, record: dict[str, Any], chat_prompts: set[str]) -> None:
    for key in ["id", "system", "prompt", "expected"]:
        if not isinstance(record.get(key), str) or not record[key].strip():
            raise ValueError(f"{path}:{index}: missing {key}")
    if record["prompt"] in chat_prompts:
        raise ValueError(f"{path}:{index}: eval prompt leaks into train/valid/test")
    for key in ["required_terms", "forbidden_terms"]:
        value = record.get(key)
        if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
            raise ValueError(f"{path}:{index}: invalid {key}")


if __name__ == "__main__":
    main()
