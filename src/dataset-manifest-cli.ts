import { buildDatasetManifest } from "./dataset-manifest.js";

const args = parseArgs(process.argv.slice(2));
const inputJsonl = splitList(args["input-jsonl"] ?? process.env.MARSHALL_DATASET_INPUT_JSONL ?? "");
if (inputJsonl.length === 0) {
  throw new Error("--input-jsonl or MARSHALL_DATASET_INPUT_JSONL is required");
}

const result = await buildDatasetManifest({
  inputJsonl,
  outputDir: args["output-dir"] ?? process.env.MARSHALL_DATASET_OUTPUT_DIR ?? ".marshall/datasets/manifest",
  datasetId: args["dataset-id"] ?? process.env.MARSHALL_DATASET_ID ?? "marshall-external-jsonl",
  version: args.version ?? process.env.MARSHALL_DATASET_VERSION ?? new Date().toISOString().slice(0, 10),
  schema: args.schema ?? process.env.MARSHALL_DATASET_SCHEMA ?? "mlx-chat-jsonl",
  license: args.license ?? process.env.MARSHALL_DATASET_LICENSE ?? "external-local-test",
  shardCount: positiveIntegerArg(args["shard-count"] ?? process.env.MARSHALL_DATASET_SHARD_COUNT, 8),
  validEvery: positiveIntegerArg(args["valid-every"] ?? process.env.MARSHALL_DATASET_VALID_EVERY, 20),
  maxRecords: optionalPositiveIntegerArg(args["max-records"] ?? process.env.MARSHALL_DATASET_MAX_RECORDS),
  textField: args["text-field"] ?? process.env.MARSHALL_DATASET_TEXT_FIELD ?? "text",
  instructionField: optionalStringArg(args["instruction-field"] ?? process.env.MARSHALL_DATASET_INSTRUCTION_FIELD),
  responseField: optionalStringArg(args["response-field"] ?? process.env.MARSHALL_DATASET_RESPONSE_FIELD),
  contextField: optionalStringArg(args["context-field"] ?? process.env.MARSHALL_DATASET_CONTEXT_FIELD),
  systemPrompt: optionalStringArg(args["system-prompt"] ?? process.env.MARSHALL_DATASET_SYSTEM_PROMPT),
  baseUri: trimTrailingSlash(args["base-uri"] ?? process.env.MARSHALL_DATASET_BASE_URI),
});

console.log(JSON.stringify(result, null, 2));

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return value.replace(/\/+$/, "");
}

function optionalStringArg(value: string | undefined): string | undefined {
  if (value == null || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function positiveIntegerArg(value: string | undefined, fallback: number): number {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value ?? fallback}`);
  }
  return parsed;
}

function optionalPositiveIntegerArg(value: string | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return positiveIntegerArg(value, 1);
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
