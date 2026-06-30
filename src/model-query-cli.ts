import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AdapterEvaluationMetricsSchema, TextClassifierEvaluationMetricsSchema } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const packagePath = args.package ?? process.env.MARSHALL_MODEL_PACKAGE;
const evalFile = args["eval-file"] ?? process.env.MARSHALL_EVAL_FILE;
const outputDir = args["output-dir"] ?? process.env.MARSHALL_QUERY_DIR ?? ".marshall/query";

if (packagePath == null) {
  throw new Error("--package or MARSHALL_MODEL_PACKAGE is required");
}
if (evalFile == null) {
  throw new Error("--eval-file or MARSHALL_EVAL_FILE is required");
}

const modelPackage = parseModelPackage(JSON.parse(await readFile(packagePath, "utf8")));
const sourceMetrics = parseEvaluationMetrics(JSON.parse(await readFile(modelPackage.eval.metrics_path, "utf8")));
const recordId = args["record-id"] ?? firstCorrectRecordId(sourceMetrics);
const record = await evalRecord(evalFile, recordId);
const queryEvalFile = join(outputDir, "query.jsonl");
const pythonBin = args.python ?? process.env.MARSHALL_PYTHON ?? "python3";
const projectRoot = resolve(args["project-root"] ?? process.cwd());
const scriptPath = modelPackage.model_kind === "text_classifier"
  ? resolve(projectRoot, "training/ag_news_text_classifier.py")
  : resolve(projectRoot, "training/mlx_ag_news_eval.py");

await mkdir(outputDir, { recursive: true });
await writeFile(queryEvalFile, JSON.stringify(record) + "\n", "utf8");

const requireCorrect = booleanArg(args["require-correct"] ?? process.env.MARSHALL_QUERY_REQUIRE_CORRECT, true);
const result = modelPackage.model_kind === "text_classifier"
  ? await runProcess(pythonBin, [
    scriptPath,
    "eval",
    "--model-path",
    modelPackage.model_path ?? modelPackage.adapter_path,
    "--eval-file",
    queryEvalFile,
    "--output-dir",
    outputDir,
    "--max-examples",
    "1",
    ...(requireCorrect ? ["--fail-under", "1.0"] : []),
  ])
  : await runProcess(pythonBin, [
    scriptPath,
    "--eval-file",
    queryEvalFile,
    "--output-dir",
    outputDir,
    "--model",
    modelPackage.base_model,
    "--adapter-path",
    modelPackage.adapter_path,
    "--max-examples",
    "1",
    "--max-tokens",
    args["max-tokens"] ?? process.env.MARSHALL_QUERY_MAX_TOKENS ?? "8",
    ...(requireCorrect ? ["--fail-under", "1.0"] : []),
  ]);
const metrics = JSON.parse(await readFile(join(outputDir, "eval.json"), "utf8"));

console.log(JSON.stringify({
  type: "marshall_model_query_completed",
  package: packagePath,
  output_dir: outputDir,
  model_kind: modelPackage.model_kind,
  adapter_id: modelPackage.adapter_id,
  record_id: recordId,
  expected_label: metrics.results[0]?.expected_label,
  predicted_label: metrics.results[0]?.predicted_label,
  output: metrics.results[0]?.output,
  correct: metrics.results[0]?.correct,
  stdout: result.stdout.trim(),
}, null, 2));

interface ModelPackage {
  type: string;
  model_kind?: string;
  base_model: string;
  adapter_id: string;
  adapter_path: string;
  adapter_artifact_hash: string;
  model_path?: string;
  eval: {
    metrics_path: string;
  };
}

function parseModelPackage(value: unknown): ModelPackage {
  if (typeof value !== "object" || value == null) {
    throw new Error("model package must be an object");
  }
  const record = value as Record<string, unknown>;
  const evalRecordValue = record.eval;
  if (typeof evalRecordValue !== "object" || evalRecordValue == null) {
    throw new Error("model package eval must be an object");
  }
  const evalRecordObject = evalRecordValue as Record<string, unknown>;
  return {
    type: stringValue(record.type, "type"),
    model_kind: optionalStringValue(record.model_kind, "model_kind"),
    base_model: stringValue(record.base_model, "base_model"),
    adapter_id: stringValue(record.adapter_id, "adapter_id"),
    adapter_path: stringValue(record.adapter_path, "adapter_path"),
    adapter_artifact_hash: stringValue(record.adapter_artifact_hash, "adapter_artifact_hash"),
    model_path: optionalStringValue(record.model_path, "model_path"),
    eval: {
      metrics_path: stringValue(evalRecordObject.metrics_path, "eval.metrics_path"),
    },
  };
}

function parseEvaluationMetrics(value: unknown) {
  const adapter = AdapterEvaluationMetricsSchema.safeParse(value);
  if (adapter.success) {
    return adapter.data;
  }
  return TextClassifierEvaluationMetricsSchema.parse(value);
}

function firstCorrectRecordId(metrics: ReturnType<typeof parseEvaluationMetrics>): string {
  const result = metrics.results.find((item) => item.correct);
  if (result == null) {
    throw new Error(`${metrics.job_id} has no correct evaluation result to query`);
  }
  return result.id;
}

async function evalRecord(path: string, recordId: string): Promise<unknown> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.id === recordId) {
      return record;
    }
  }
  throw new Error(`${path} does not contain eval record ${recordId}`);
}

function runProcess(command: string, values: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, values, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `query process exited ${exitCode ?? "unknown"}`));
    });
  });
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function optionalStringValue(value: unknown, field: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  return stringValue(value, field);
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

function booleanArg(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new Error(`invalid boolean: ${value}`);
}
