import { ControlPeer } from "./control-peer.js";
import { createTrainingJob } from "./jobs.js";
import type { TrainingJob } from "./schemas.js";

const args = parseArgs(process.argv.slice(2));
const jobType = jobTypeArg(args["job-type"] ?? process.env.MARSHALL_JOB_TYPE ?? "train_toy_model");
const control = await ControlPeer.create({
  privateKeyPath: args.key ?? process.env.MARSHALL_CONTROL_KEY ?? ".marshall/control.key",
  listen: splitList(args.listen ?? process.env.MARSHALL_CONTROL_LISTEN ?? "/ip4/0.0.0.0/tcp/4001"),
  coordinatorUrl: args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL,
  jobs: [
    createTrainingJob(jobType, {
      jobId: args["job-id"] ?? process.env.MARSHALL_JOB_ID,
      runId: args["run-id"] ?? process.env.MARSHALL_RUN_ID,
      roundId: args["round-id"] ?? process.env.MARSHALL_ROUND_ID,
    }),
  ],
});

console.log(JSON.stringify({
  type: "marshall_control_started",
  peer_id: control.peerId,
  addrs: control.multiaddrs.map((addr) => addr.toString()),
  job_type: jobType,
  coordinator_url: args["coordinator-url"] ?? process.env.MARSHALL_COORDINATOR_URL ?? null,
}, null, 2));

await waitForShutdown(async () => {
  await control.stop();
});

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

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function jobTypeArg(value: string): TrainingJob["job_type"] {
  if (value === "train_toy_model" || value === "train_mlx_smoke" || value === "train_adapter") {
    return value;
  }
  throw new Error(`unsupported CLI job type: ${value}`);
}

async function waitForShutdown(onShutdown: () => Promise<void>): Promise<void> {
  let stopping = false;
  await new Promise<void>((resolve) => {
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      void onShutdown().finally(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
