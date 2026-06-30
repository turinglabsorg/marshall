import type { AdapterEvaluationMetrics } from "./schemas.js";

export const BEST_ADAPTER_STRATEGY_ID = "best_adapter_by_eval_score";

export interface AdapterEvaluationCandidate {
  metrics: AdapterEvaluationMetrics;
  metricsPath: string;
  verdict?: string;
}

export interface AdapterLeaderboardEntry {
  rank: number;
  adapter_id: string;
  adapter_path: string | null;
  adapter_artifact_hash: string;
  job_id: string;
  eval_shard_id: string;
  examples: number;
  correct: number;
  accuracy: number;
  invalid: number;
  invalid_rate: number;
  score: number;
  verdict?: string;
  metrics_path: string;
}

export interface ModelSelectionPolicy {
  id: typeof BEST_ADAPTER_STRATEGY_ID;
  score_formula: "accuracy - invalid_rate";
  tie_breakers: string[];
  merge_mode: "single_adapter";
  top_k: number;
  require_verdict: string | null;
}

export interface AdapterSelectionResult {
  policy: ModelSelectionPolicy;
  entries: AdapterLeaderboardEntry[];
  topK: AdapterLeaderboardEntry[];
  selected: AdapterLeaderboardEntry | null;
}

export interface RankAdapterEvaluationsOptions {
  topK: number;
  requireVerdict?: string;
}

export function rankAdapterEvaluations(
  candidates: AdapterEvaluationCandidate[],
  options: RankAdapterEvaluationsOptions,
): AdapterSelectionResult {
  const policy: ModelSelectionPolicy = {
    id: BEST_ADAPTER_STRATEGY_ID,
    score_formula: "accuracy - invalid_rate",
    tie_breakers: ["accuracy desc", "adapter_id asc"],
    merge_mode: "single_adapter",
    top_k: options.topK,
    require_verdict: options.requireVerdict ?? null,
  };

  const entries = candidates
    .filter((candidate) => options.requireVerdict == null || candidate.verdict === options.requireVerdict)
    .map((candidate) => leaderboardEntry(candidate));

  entries.sort((left, right) =>
    right.score - left.score
    || right.accuracy - left.accuracy
    || left.adapter_id.localeCompare(right.adapter_id),
  );
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const topK = entries.slice(0, options.topK);
  return {
    policy,
    entries,
    topK,
    selected: topK[0] ?? null,
  };
}

function leaderboardEntry(candidate: AdapterEvaluationCandidate): AdapterLeaderboardEntry {
  const { metrics } = candidate;
  return {
    rank: 0,
    adapter_id: metrics.adapter_id,
    adapter_path: metrics.adapter_path,
    adapter_artifact_hash: metrics.adapter_artifact_hash,
    job_id: metrics.job_id,
    eval_shard_id: metrics.eval_shard_id,
    examples: metrics.examples,
    correct: metrics.correct,
    accuracy: metrics.accuracy,
    invalid: metrics.invalid,
    invalid_rate: metrics.invalid_rate,
    score: metrics.accuracy - metrics.invalid_rate,
    verdict: candidate.verdict,
    metrics_path: candidate.metricsPath,
  };
}
