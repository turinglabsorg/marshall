import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CoordinatorClient } from "./coordinator-client.js";
import { AdapterEvaluationMetricsSchema } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const evalArtifactsDir = args["eval-artifacts-dir"] ?? process.env.MARSHALL_EVAL_ARTIFACTS_DIR ?? ".marshall/eval-artifacts";
const outputDir = args["output-dir"] ?? process.env.MARSHALL_LEADERBOARD_DIR ?? ".marshall/leaderboard";
const topK = numberArg(args["top-k"] ?? process.env.MARSHALL_TOP_K, 10);
const coordinatorUrl = args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL;
const requireVerdict = args["require-verdict"] ?? process.env.MARSHALL_LEADERBOARD_REQUIRE_VERDICT;

if (requireVerdict != null && (coordinatorUrl == null || coordinatorUrl === "")) {
  throw new Error("--require-verdict requires --coordinator-url or MARSHALL_COORDINATOR_URL");
}

const artifactVerdicts = coordinatorUrl == null || coordinatorUrl === ""
  ? new Map<string, string>()
  : await artifactVerdictsByJob(coordinatorUrl, args["coordinator-token"] ?? process.env.MARSHALL_COORDINATOR_TOKEN);

const metricsPaths = await findMetrics(evalArtifactsDir);
const rows = [];
for (const path of metricsPaths) {
  const metrics = AdapterEvaluationMetricsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const verdict = artifactVerdicts.get(metrics.job_id);
  if (requireVerdict != null && verdict !== requireVerdict) {
    continue;
  }
  const score = metrics.accuracy - metrics.invalid_rate;
  rows.push({
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
    score,
    verdict,
    metrics_path: path,
  });
}

rows.sort((left, right) =>
  right.score - left.score
  || right.accuracy - left.accuracy
  || left.adapter_id.localeCompare(right.adapter_id),
);
rows.forEach((row, index) => {
  row.rank = index + 1;
});

const selected = rows.slice(0, topK);
const best = selected[0] ?? null;
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "leaderboard.json"), JSON.stringify({
  type: "marshall_adapter_leaderboard",
  entries: rows,
}, null, 2) + "\n", "utf8");
await writeFile(join(outputDir, "top_k.json"), JSON.stringify({
  type: "marshall_adapter_top_k",
  top_k: topK,
  entries: selected,
}, null, 2) + "\n", "utf8");
await writeFile(join(outputDir, "optimized_model.json"), JSON.stringify({
  type: "marshall_optimized_model_selection",
  strategy: "best_adapter_by_eval_score",
  selected: best,
}, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  type: "marshall_leaderboard_created",
  eval_artifacts_dir: evalArtifactsDir,
  output_dir: outputDir,
  evaluated_adapters: rows.length,
  top_k: topK,
  require_verdict: requireVerdict ?? null,
  best,
}, null, 2));

async function artifactVerdictsByJob(coordinatorUrlValue: string, coordinatorToken: string | undefined): Promise<Map<string, string>> {
  const client = new CoordinatorClient(coordinatorUrlValue, { token: coordinatorToken });
  const artifacts = await client.artifacts();
  return new Map(
    artifacts
      .filter((artifact) => artifact.verdict != null && artifact.verdict !== "")
      .map((artifact) => [artifact.job_id, artifact.verdict!]),
  );
}

async function findMetrics(root: string): Promise<string[]> {
  const paths: string[] = [];
  await walk(root, paths);
  return paths.filter((path) => basename(path) === "metrics.json");
}

async function walk(path: string, output: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await walk(child, output);
      continue;
    }
    if (entry.isFile()) {
      output.push(child);
    }
  }
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next == null || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value == null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}
