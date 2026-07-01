import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("worker supervisor CLI", () => {
  it("starts one unified model worker pool for training, evaluation, and validation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-worker-supervisor-"));
    const logPath = join(tempDir, "pool.log");
    const fakePool = join(tempDir, "fake-worker-pool.mjs");
    await writeFile(fakePool, `
import { appendFileSync } from "node:fs";

appendFileSync(process.env.FAKE_POOL_LOG, JSON.stringify({
  control: value("--control"),
  job_types: value("--job-types"),
  backend: value("--backend"),
  concurrency: value("--concurrency"),
  worker_id_prefix: value("--worker-id-prefix"),
  state_key_dir: value("--key-dir"),
  memory_gb: value("--memory-gb"),
  slot_memory_gb: value("--slot-memory-gb"),
  python: value("--python"),
}) + "\\n");

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
        "src/worker-supervisor-cli.ts",
        "--control",
        "/ip4/127.0.0.1/tcp/1/p2p/test",
        "--worker-id-base",
        "MacBookPro",
        "--state-dir",
        join(tempDir, "state"),
        "--model-concurrency",
        "2",
        "--memory-gb",
        "32",
        "--slot-memory-gb",
        "16",
        "--python",
        "/tmp/mlx-python",
        "--worker-script",
        fakePool,
        "--once",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, FAKE_POOL_LOG: logPath },
        timeout: 10_000,
      },
    );

    const summary = JSON.parse(stdout);
    expect(summary.roles).toEqual([
      {
        name: "model",
        job_types: ["train_adapter", "evaluate_adapter", "validate_artifact"],
        backend: "mlx",
        concurrency: 2,
      },
    ]);

    const poolRuns = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(poolRuns).toHaveLength(1);
    expect(poolRuns[0]).toMatchObject({
      job_types: "train_adapter,evaluate_adapter,validate_artifact",
      backend: "mlx",
      concurrency: "2",
      worker_id_prefix: "MacBookPro-marshall-model",
      memory_gb: "32",
      slot_memory_gb: "16",
      python: "/tmp/mlx-python",
    });
  });

  it("collapses legacy role concurrency flags into one model pool", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-worker-supervisor-legacy-"));
    const logPath = join(tempDir, "pool.log");
    const fakePool = join(tempDir, "fake-worker-pool.mjs");
    await writeFile(fakePool, `
import { appendFileSync } from "node:fs";

appendFileSync(process.env.FAKE_POOL_LOG, JSON.stringify({
  job_types: value("--job-types"),
  concurrency: value("--concurrency"),
}) + "\\n");

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    throw new Error("missing " + flag);
  }
  return process.argv[index + 1];
}
`, "utf8");

    await execFileAsync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "src/worker-supervisor-cli.ts",
        "--control",
        "/ip4/127.0.0.1/tcp/1/p2p/test",
        "--worker-id-base",
        "MacBookPro",
        "--state-dir",
        join(tempDir, "state"),
        "--train-concurrency",
        "1",
        "--eval-concurrency",
        "1",
        "--validation-concurrency",
        "3",
        "--memory-gb",
        "32",
        "--python",
        "/tmp/mlx-python",
        "--worker-script",
        fakePool,
        "--once",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, FAKE_POOL_LOG: logPath },
        timeout: 10_000,
      },
    );

    const poolRuns = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(poolRuns).toEqual([
      {
        job_types: "train_adapter,evaluate_adapter,validate_artifact",
        concurrency: "3",
      },
    ]);
  });
});
