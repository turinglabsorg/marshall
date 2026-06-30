import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("dataset manifest CLI", () => {
  it("builds chat shards from instruction and response records", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marshall-dataset-manifest-cli-test-"));
    try {
      const inputPath = join(tempDir, "input.jsonl");
      const outputDir = join(tempDir, "dataset");
      await writeFile(inputPath, [
        JSON.stringify({
          instruction: "Explain Marshall workers.",
          context: "Workers claim p2p jobs and publish artifacts.",
          response: "Marshall workers execute assigned jobs and return verified artifacts.",
        }),
        JSON.stringify({
          instruction: "What should validators check?",
          context: "",
          response: "Validators should verify hashes, metrics, and policy thresholds.",
        }),
        "",
      ].join("\n"), "utf8");

      await execFileAsync(process.execPath, [
        join(process.cwd(), "node_modules/.bin/tsx"),
        "src/dataset-manifest-cli.ts",
        "--input-jsonl", inputPath,
        "--output-dir", outputDir,
        "--dataset-id", "instruction-smoke",
        "--shard-count", "2",
        "--valid-every", "2",
        "--instruction-field", "instruction",
        "--response-field", "response",
        "--context-field", "context",
        "--system-prompt", "You are a concise Marshall assistant.",
      ], {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      });

      const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
        dataset_id: string;
        sharding: {
          transform: string;
          instruction_field: string;
          response_field: string;
          context_field: string;
        };
        shards: Array<{ files: Array<{ path: string; bytes: number }> }>;
      };
      expect(manifest.dataset_id).toBe("instruction-smoke");
      expect(manifest.sharding).toMatchObject({
        transform: "instruction_response",
        instruction_field: "instruction",
        response_field: "response",
        context_field: "context",
      });
      expect(manifest.shards).toHaveLength(2);
      expect(manifest.shards[0].files.some((file) => file.path === "valid.jsonl" && file.bytes > 0)).toBe(true);

      const validRecord = JSON.parse((await readFile(join(outputDir, "shards", "shard-000001", "valid.jsonl"), "utf8")).trim()) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(validRecord.messages).toEqual([
        { role: "system", content: "You are a concise Marshall assistant." },
        {
          role: "user",
          content: "Explain Marshall workers.\n\nContext:\nWorkers claim p2p jobs and publish artifacts.",
        },
        { role: "assistant", content: "Marshall workers execute assigned jobs and return verified artifacts." },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
