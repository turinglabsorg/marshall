import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
  publicKeyToProtobuf,
} from "@libp2p/crypto/keys";
import type { PrivateKey } from "@libp2p/interface";

export async function loadOrCreatePrivateKey(path: string): Promise<PrivateKey> {
  try {
    const encoded = await readFile(path, "utf8");
    return privateKeyFromProtobuf(Buffer.from(encoded, "base64"));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const privateKey = await generateKeyPair("Ed25519");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(privateKeyToProtobuf(privateKey)).toString("base64"), {
    mode: 0o600,
  });
  return privateKey;
}

export function publicKeyBase64(privateKey: PrivateKey): string {
  return Buffer.from(publicKeyToProtobuf(privateKey.publicKey)).toString("base64");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
