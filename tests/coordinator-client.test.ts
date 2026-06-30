import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorClient } from "../src/coordinator-client.js";

describe("coordinator client", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("retries transient coordinator status write failures", async () => {
    let attempts = 0;
    const server = await listen(async (_request, response) => {
      attempts += 1;
      if (attempts === 1) {
        writeJSON(response, 400, { error: "dial tcp 127.0.0.1:6379: i/o timeout" });
        return;
      }
      writeJSON(response, 200, {
        id: "event-001",
        type: "job_status_updated",
        fields: {
          job_id: "job_retry_001",
          worker_id: "worker_retry_001",
          status: "completed",
        },
      });
    });
    servers.push(server);

    const client = new CoordinatorClient(server.url);
    await client.updateJobStatus({
      job_id: "job_retry_001",
      worker_id: "worker_retry_001",
      peer_id: "12D3KooWRetry",
      status: "completed",
    });

    expect(attempts).toBe(2);
  });
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error == null ? resolve() : reject(error));
    }),
  };
}

function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
