import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CoordinatorClient } from "./coordinator-client.js";
import { rankAdapterEvaluations, type AdapterEvaluationCandidate } from "./model-selection.js";
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
const candidates: AdapterEvaluationCandidate[] = [];
let skippedMetrics = 0;
for (const path of metricsPaths) {
  const parsed = AdapterEvaluationMetricsSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    skippedMetrics += 1;
    continue;
  }
  const metrics = parsed.data;
  const verdict = artifactVerdicts.get(metrics.job_id);
  candidates.push({
    metrics,
    metricsPath: path,
    verdict,
  });
}

const selection = rankAdapterEvaluations(candidates, {
  topK,
  requireVerdict,
});
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "leaderboard.json"), JSON.stringify({
  type: "marshall_adapter_leaderboard",
  selection_policy: selection.policy,
  entries: selection.entries,
}, null, 2) + "\n", "utf8");
await writeFile(join(outputDir, "top_k.json"), JSON.stringify({
  type: "marshall_adapter_top_k",
  selection_policy: selection.policy,
  top_k: selection.policy.top_k,
  entries: selection.topK,
}, null, 2) + "\n", "utf8");
await writeFile(join(outputDir, "optimized_model.json"), JSON.stringify({
  type: "marshall_optimized_model_selection",
  strategy: selection.policy.id,
  selection_policy: selection.policy,
  selected: selection.selected,
}, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  type: "marshall_leaderboard_created",
  eval_artifacts_dir: evalArtifactsDir,
  output_dir: outputDir,
  evaluated_adapters: selection.entries.length,
  skipped_metrics: skippedMetrics,
  top_k: topK,
  require_verdict: requireVerdict ?? null,
  best: selection.selected,
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
