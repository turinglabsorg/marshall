import { describe, expect, it } from "vitest";
import { rankAdapterEvaluations, type AdapterEvaluationCandidate } from "../src/model-selection.js";
import type { AdapterEvaluationMetrics } from "../src/schemas.js";

describe("adapter model selection", () => {
  it("selects accepted adapters by accuracy minus invalid rate", () => {
    const selection = rankAdapterEvaluations([
      candidate(metrics("adapter_rejected", {
        jobId: "job_eval_rejected",
        accuracy: 0.99,
        invalidRate: 0,
      }), "rejected"),
      candidate(metrics("adapter_accepted_low_invalid", {
        jobId: "job_eval_low_invalid",
        accuracy: 0.8,
        invalidRate: 0,
      }), "accepted"),
      candidate(metrics("adapter_accepted_high_invalid", {
        jobId: "job_eval_high_invalid",
        accuracy: 0.9,
        invalidRate: 0.2,
      }), "accepted"),
    ], {
      topK: 2,
      requireVerdict: "accepted",
    });

    expect(selection.policy).toMatchObject({
      id: "best_adapter_by_eval_score",
      score_formula: "accuracy - invalid_rate",
      merge_mode: "single_adapter",
      require_verdict: "accepted",
    });
    expect(selection.entries.map((entry) => entry.adapter_id)).toEqual([
      "adapter_accepted_low_invalid",
      "adapter_accepted_high_invalid",
    ]);
    expect(selection.selected?.score).toBe(0.8);
  });

  it("uses deterministic tie breakers", () => {
    const selection = rankAdapterEvaluations([
      candidate(metrics("adapter_b", {
        jobId: "job_eval_b",
        accuracy: 0.7,
        invalidRate: 0,
      })),
      candidate(metrics("adapter_a", {
        jobId: "job_eval_a",
        accuracy: 0.7,
        invalidRate: 0,
      })),
    ], {
      topK: 1,
    });

    expect(selection.selected?.adapter_id).toBe("adapter_a");
    expect(selection.topK).toHaveLength(1);
  });
});

function candidate(metricsValue: AdapterEvaluationMetrics, verdict?: string): AdapterEvaluationCandidate {
  return {
    metrics: metricsValue,
    metricsPath: `.marshall/test/${metricsValue.job_id}/metrics.json`,
    verdict,
  };
}

function metrics(
  adapterId: string,
  options: {
    jobId: string;
    accuracy: number;
    invalidRate: number;
  },
): AdapterEvaluationMetrics {
  const examples = 10;
  const correct = Math.round(options.accuracy * examples);
  const invalid = Math.round(options.invalidRate * examples);
  return {
    job_id: options.jobId,
    run_id: "run_selection_test",
    round_id: "round_001",
    adapter_id: adapterId,
    adapter_artifact_hash: `sha256:${adapterId}`,
    eval_shard_id: "eval_selection",
    eval_shard_hash: "sha256:eval-selection",
    eval_kind: "ag_news",
    model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    adapter_path: `/tmp/${adapterId}`,
    eval_file: "eval.jsonl",
    examples,
    correct,
    accuracy: options.accuracy,
    invalid,
    invalid_rate: options.invalidRate,
    labels: ["World", "Sports"],
    results: [],
  };
}
