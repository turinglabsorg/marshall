import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashDatasetPath } from "./dataset-cache.js";
import { TextClassifierEvaluationJobSchema, TrainingArtifactManifestSchema, type TextClassifierEvaluationJob } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const artifactsDir = args["artifacts-dir"] ?? process.env.MARSHALL_ARTIFACTS_DIR ?? ".marshall/artifacts";
const evalFile = args["eval-file"] ?? process.env.MARSHALL_EVAL_FILE;
const outputFile = args.output ?? process.env.MARSHALL_EVAL_JOBS_FILE ?? ".marshall/jobs/evaluate-text-classifiers.json";

if (evalFile == null) {
  throw new Error("--eval-file or MARSHALL_EVAL_FILE is required");
}

const jobs = await createTextClassifierEvaluationJobs({
  artifactsDir,
  evalFile,
  runId: args["run-id"] ?? process.env.MARSHALL_RUN_ID ?? "run_text_classifier_eval_001",
  roundId: args["round-id"] ?? process.env.MARSHALL_ROUND_ID ?? "round_001",
  jobPrefix: args["job-prefix"] ?? process.env.MARSHALL_JOB_ID ?? "job_eval_text_classifier",
  maxExamples: numberArg(args["max-examples"] ?? process.env.MARSHALL_EVAL_EXAMPLES, 80),
  limit: optionalNumberArg(args.limit ?? process.env.MARSHALL_EVAL_CLASSIFIER_LIMIT),
  classifierJobPrefix: args["classifier-job-prefix"] ?? process.env.MARSHALL_EVAL_CLASSIFIER_JOB_PREFIX,
});

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(jobs, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  type: "marshall_text_classifier_evaluation_jobs_created",
  output_file: outputFile,
  jobs: jobs.length,
  artifacts_dir: artifactsDir,
  eval_file: evalFile,
}, null, 2));

interface CreateTextClassifierEvaluationJobsOptions {
  artifactsDir: string;
  evalFile: string;
  runId: string;
  roundId: string;
  jobPrefix: string;
  maxExamples: number;
  limit?: number;
  classifierJobPrefix?: string;
}

async function createTextClassifierEvaluationJobs(options: CreateTextClassifierEvaluationJobsOptions): Promise<TextClassifierEvaluationJob[]> {
  const evalPath = resolve(options.evalFile);
  const evalHash = await hashDatasetPath(evalPath);
  const manifests = await findArtifactManifests(options.artifactsDir);
  const classifierManifests = [];
  for (const manifestPath of manifests) {
    const manifest = TrainingArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (
      manifest.artifact_type === "text_classifier_model"
      && (options.classifierJobPrefix == null || manifest.job_id.startsWith(options.classifierJobPrefix))
    ) {
      classifierManifests.push({ manifestPath, manifest });
    }
  }

  classifierManifests.sort((left, right) => left.manifest.job_id.localeCompare(right.manifest.job_id));
  const selected = options.limit == null ? classifierManifests : classifierManifests.slice(0, options.limit);

  return selected.map(({ manifest }, index) => {
    const suffix = String(index + 1).padStart(6, "0");
    return TextClassifierEvaluationJobSchema.parse({
      job_id: `${options.jobPrefix}_${suffix}`,
      run_id: options.runId,
      round_id: options.roundId,
      job_type: "evaluate_text_classifier",
      backend: "cpu",
      model: "ag_news_naive_bayes",
      classifier: {
        adapter_id: manifest.job_id,
        artifact_uri: manifest.artifact_uri,
        artifact_hash: manifest.artifact_hash,
        config_hash: manifest.config_hash,
        source_job_id: manifest.job_id,
      },
      eval_shard: {
        id: basename(options.evalFile).replace(/[^a-zA-Z0-9_-]+/g, "_") || "eval_jsonl",
        uri: pathToFileURL(evalPath).toString(),
        token_estimate: 1,
        hash: evalHash,
      },
      max_examples: options.maxExamples,
    });
  });
}

async function findArtifactManifests(root: string): Promise<string[]> {
  const paths: string[] = [];
  await walk(root, paths);
  return paths.filter((path) => basename(path) === "manifest.json");
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

function optionalNumberArg(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  return numberArg(value, 1);
}
