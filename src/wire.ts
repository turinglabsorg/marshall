import { concat } from "uint8arrays/concat";
import { fromString } from "uint8arrays/from-string";
import { toString } from "uint8arrays/to-string";
import type { DialTarget, Libp2p, Stream } from "@libp2p/interface";
import type { ProtocolName } from "./protocols.js";

export async function readJson(stream: Stream): Promise<unknown> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk instanceof Uint8Array ? chunk : chunk.slice());
  }

  if (chunks.length === 0) {
    throw new Error("empty stream payload");
  }

  return JSON.parse(toString(concat(chunks)));
}

export async function writeJson(stream: Stream, payload: unknown): Promise<void> {
  stream.send(fromString(JSON.stringify(payload)));
  await stream.close();
}

export async function requestJson(
  node: Libp2p,
  target: DialTarget,
  protocol: ProtocolName,
  payload: unknown,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const stream = await node.dialProtocol(target, protocol, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });

  await writeJson(stream, payload);
  return readJson(stream);
}
