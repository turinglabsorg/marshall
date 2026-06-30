import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("worker pool CLI", () => {
  it("keeps stable worker slots and refills them until max jobs complete", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-worker-pool-"));
    const logPath = join(tempDir, "workers.log");
    const fakeWorker = join(tempDir, "fake-worker.mjs");
    await writeFile(fakeWorker, `
import { appendFileSync } from "node:fs";

const workerID = value("--worker-id");
appendFileSync(process.env.FAKE_WORKER_LOG, workerID + "\\n");
await new Promise((resolve) => setTimeout(resolve, 25));
console.log(JSON.stringify({ type: "fake_worker_completed", worker_id: workerID }));

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    throw new Error("missing " + flag);
  }
  return process.argv[index + 1];
}
`, "utf8");

    const { stdout } = await execFileAsync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "src/worker-pool-cli.ts",
        "--control",
        "/ip4/127.0.0.1/tcp/1/p2p/test",
        "--job-type",
        "train_toy_model",
        "--backend",
        "cpu",
        "--concurrency",
        "2",
        "--max-jobs",
        "4",
        "--worker-id-prefix",
        "pool",
        "--key-dir",
        join(tempDir, "keys"),
        "--worker-script",
        fakeWorker,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, FAKE_WORKER_LOG: logPath },
        timeout: 10_000,
      },
    );

    const summary = JSON.parse(stdout);
    expect(summary.completed).toBe(4);
    expect(summary.failed).toBe(0);
    expect(summary.persistent).toBe(false);

    const workerIDs = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(workerIDs).toHaveLength(4);
    expect(new Set(workerIDs).size).toBeLessThanOrEqual(2);
    expect(workerIDs.every((workerID) => workerID === "pool-0001" || workerID === "pool-0002")).toBe(true);
  });

  it("keeps persistent mode unbounded and can exit explicitly when idle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-worker-pool-idle-"));
    const fakeWorker = join(tempDir, "fake-idle-worker.mjs");
    await writeFile(fakeWorker, `
console.error("no job assigned: empty queue");
process.exit(1);
`, "utf8");

    const { stdout } = await execFileAsync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "src/worker-pool-cli.ts",
        "--control",
        "/ip4/127.0.0.1/tcp/1/p2p/test",
        "--job-type",
        "train_toy_model",
        "--backend",
        "cpu",
        "--concurrency",
        "1",
        "--idle-backoff-ms",
        "1",
        "--exit-when-idle",
        "--worker-id-prefix",
        "pool",
        "--key-dir",
        join(tempDir, "keys"),
        "--worker-script",
        fakeWorker,
      ],
      {
        cwd: process.cwd(),
        timeout: 10_000,
      },
    );

    const summary = JSON.parse(stdout);
    expect(summary.max_jobs).toBeNull();
    expect(summary.persistent).toBe(true);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.idle_claims).toBe(1);
  });
});
