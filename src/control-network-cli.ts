import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseControlNetwork, type ControlNetworkManifest } from "./control-network.js";

const args = parseArgs(process.argv.slice(2));
const infoFiles = splitList(args["control-info"] ?? process.env.MARSHALL_CONTROL_INFO_FILES);
const output = args.output ?? process.env.MARSHALL_CONTROL_NETWORK_OUTPUT;

if (infoFiles.length === 0) {
  throw new Error("--control-info is required");
}

const peers = [];
for (const infoFile of infoFiles) {
  const parsed = parseControlNetwork(JSON.parse(await readFile(infoFile, "utf8")));
  peers.push(...parsed.peers);
}

const deduped = new Map<string, ControlNetworkManifest["peers"][number]>();
for (const peer of peers) {
  deduped.set(peer.control_addr, peer);
}

const network: ControlNetworkManifest = {
  type: "marshall_control_network",
  version: 1,
  updated_at: new Date().toISOString(),
  peers: [...deduped.values()].sort((left, right) => roleRank(left.role) - roleRank(right.role)
    || left.coordinator_id.localeCompare(right.coordinator_id)),
};

const json = JSON.stringify(network, null, 2) + "\n";
if (output == null || output === "") {
  process.stdout.write(json);
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, json, "utf8");
  console.log(JSON.stringify({
    type: "marshall_control_network_written",
    output,
    peers: network.peers.length,
  }, null, 2));
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
    if (parsed[key] == null) {
      parsed[key] = next;
    } else {
      parsed[key] = `${parsed[key]},${next}`;
    }
    index += 1;
  }
  return parsed;
}

function splitList(value: string | undefined): string[] {
  if (value == null || value === "") {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function roleRank(role: ControlNetworkManifest["peers"][number]["role"]): number {
  if (role === "primary") {
    return 0;
  }
  if (role === "mirror") {
    return 1;
  }
  return 2;
}
