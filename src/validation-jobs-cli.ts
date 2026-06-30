import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CoordinatorClient } from "./coordinator-client.js";
import { ArtifactValidationJobSchema, type ArtifactValidationJob, type ArtifactValidationPolicy } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const coordinatorUrl = args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL;
const outputFile = args.output ?? process.env.MARSHALL_VALIDATION_JOBS_FILE ?? ".marshall/jobs/validate-artifacts.json";

if (coordinatorUrl == null || coordinatorUrl === "") {
  throw new Error("--coordinator-url or MARSHALL_COORDINATOR_URL is required");
}

const coordinator = new CoordinatorClient(coordinatorUrl, {
  token: args["coordinator-token"] ?? process.env.MARSHALL_COORDINATOR_TOKEN,
});
const jobs = await createArtifactValidationJobs({
  coordinator,
  runId: args["run-id"] ?? process.env.MARSHALL_RUN_ID ?? "run_artifact_validation_001",
  roundId: args["round-id"] ?? process.env.MARSHALL_ROUND_ID ?? "round_001",
  jobPrefix: args["job-prefix"] ?? process.env.MARSHALL_JOB_ID ?? "job_validate_artifact",
  targetArtifactType: args["target-artifact-type"] ?? process.env.MARSHALL_VALIDATION_TARGET_ARTIFACT_TYPE ?? "adapter_evaluation",
  targetJobPrefix: args["target-job-prefix"] ?? process.env.MARSHALL_VALIDATION_TARGET_JOB_PREFIX,
  includeValidated: booleanArg(args["include-validated"] ?? process.env.MARSHALL_INCLUDE_VALIDATED_ARTIFACTS, false),
  limit: optionalNumberArg(args.limit ?? process.env.MARSHALL_VALIDATION_JOB_LIMIT),
  policy: {
    min_accuracy: numberArg(args["min-accuracy"] ?? process.env.MARSHALL_VALIDATION_MIN_ACCURACY, 0.3),
    max_invalid_rate: numberArg(args["max-invalid-rate"] ?? process.env.MARSHALL_VALIDATION_MAX_INVALID_RATE, 0.2),
    min_examples: integerArg(args["min-examples"] ?? process.env.MARSHALL_VALIDATION_MIN_EXAMPLES, 1),
  },
});

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(jobs, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  type: "marshall_validation_jobs_created",
  output_file: outputFile,
  jobs: jobs.length,
  coordinator_url: coordinatorUrl,
}, null, 2));

interface CreateArtifactValidationJobsOptions {
  coordinator: CoordinatorClient;
  runId: string;
  roundId: string;
  jobPrefix: string;
  targetArtifactType: string;
  targetJobPrefix?: string;
  includeValidated: boolean;
  limit?: number;
  policy: Required<ArtifactValidationPolicy>;
}

async function createArtifactValidationJobs(options: CreateArtifactValidationJobsOptions): Promise<ArtifactValidationJob[]> {
  const artifacts = await options.coordinator.artifacts();
  const targets = artifacts
    .filter((artifact) => artifact.artifact_type === options.targetArtifactType)
    .filter((artifact) => options.targetJobPrefix == null || artifact.job_id.startsWith(options.targetJobPrefix))
    .filter((artifact) => options.includeValidated || artifact.verdict == null || artifact.verdict === "")
    .sort((left, right) => left.job_id.localeCompare(right.job_id));
  const selected = options.limit == null ? targets : targets.slice(0, options.limit);

  return selected.map((artifact, index) => {
    const suffix = String(index + 1).padStart(6, "0");
    return ArtifactValidationJobSchema.parse({
      job_id: `${options.jobPrefix}_${suffix}`,
      run_id: options.runId,
      round_id: options.roundId,
      job_type: "validate_artifact",
      backend: "cpu",
      target: {
        job_id: artifact.job_id,
        worker_id: artifact.worker_id,
        peer_id: artifact.peer_id,
        artifact_type: artifact.artifact_type,
        artifact_uri: artifact.artifact_uri,
        artifact_hash: artifact.artifact_hash,
        config_hash: artifact.config_hash,
        metrics_uri: artifact.metrics_uri,
      },
      policy: options.policy,
    });
  });
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
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}

function integerArg(value: string | undefined, fallback: number): number {
  const parsed = numberArg(value, fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value ?? fallback}`);
  }
  return parsed;
}

function optionalNumberArg(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  return integerArg(value, 1);
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
