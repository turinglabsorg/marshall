import { readFile } from "node:fs/promises";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";

export interface ControlNetworkPeer {
  coordinator_id: string;
  role: "primary" | "mirror" | "artifact_provider";
  peer_id: string;
  control_addr: string;
  addrs?: string[];
  artifact_fetch: true;
  coordinator_url?: string | null;
}

export interface ControlNetworkManifest {
  type: "marshall_control_network";
  version: 1;
  updated_at: string;
  peers: ControlNetworkPeer[];
}

export interface ResolveControlAddrsOptions {
  controlAddr?: string;
  controlAddrs?: string;
  controlNetworkPath?: string;
  controlNetworkUrl?: string;
  fetchImpl?: (url: string, init?: { cache?: string }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export async function resolveControlMultiaddrs(options: ResolveControlAddrsOptions): Promise<Multiaddr[]> {
  const explicit = [
    ...splitList(options.controlAddr),
    ...splitList(options.controlAddrs),
  ];
  const network = await loadControlNetworkSource({
    path: options.controlNetworkPath,
    url: options.controlNetworkUrl,
    fetchImpl: options.fetchImpl,
  });
  const values = [
    ...explicit,
    ...network.peers.filter((peer) => peer.artifact_fetch).map((peer) => peer.control_addr),
  ];
  const deduped = [...new Set(values)];
  if (deduped.length === 0) {
    throw new Error("--control, --control-addrs, or --control-network-url/path is required");
  }
  return deduped.map((value) => multiaddr(value));
}

export async function loadControlNetworkSource(options: {
  path?: string;
  url?: string;
  fetchImpl?: ResolveControlAddrsOptions["fetchImpl"];
}): Promise<ControlNetworkManifest> {
  if (options.path != null && options.path !== "") {
    return parseControlNetwork(JSON.parse(await readFile(options.path, "utf8")));
  }
  if (options.url != null && options.url !== "") {
    const fetcher = options.fetchImpl ?? fetch;
    const response = await fetcher(options.url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`control network request failed ${response.status}`);
    }
    return parseControlNetwork(await response.json());
  }
  return emptyControlNetwork();
}

export function parseControlNetwork(value: unknown): ControlNetworkManifest {
  if (typeof value !== "object" || value == null) {
    throw new Error("control network must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.type === "marshall_control_started") {
    return singleControlInfo(record);
  }
  if (record.type !== "marshall_control_network" || record.version !== 1 || !Array.isArray(record.peers)) {
    throw new Error("invalid Marshall control network");
  }
  return {
    type: "marshall_control_network",
    version: 1,
    updated_at: stringValue(record.updated_at, "updated_at", true) || new Date(0).toISOString(),
    peers: record.peers.map(parseControlNetworkPeer),
  };
}

function singleControlInfo(record: Record<string, unknown>): ControlNetworkManifest {
  const peerId = stringValue(record.peer_id, "peer_id");
  const controlAddr = stringValue(record.control_addr, "control_addr");
  const role = controlRole(record.coordinator_role, "primary");
  return {
    type: "marshall_control_network",
    version: 1,
    updated_at: new Date().toISOString(),
    peers: [{
      coordinator_id: stringValue(record.coordinator_id, "coordinator_id", true) || "primary",
      role,
      peer_id: peerId,
      control_addr: controlAddr,
      addrs: Array.isArray(record.addrs) ? record.addrs.map((item) => stringValue(item, "addrs[]")) : undefined,
      artifact_fetch: true,
      coordinator_url: typeof record.coordinator_url === "string" ? record.coordinator_url : null,
    }],
  };
}

function parseControlNetworkPeer(value: unknown): ControlNetworkPeer {
  if (typeof value !== "object" || value == null) {
    throw new Error("control network peer must be an object");
  }
  const record = value as Record<string, unknown>;
  const role = record.role;
  if (role !== "primary" && role !== "mirror" && role !== "artifact_provider") {
    throw new Error("invalid control network peer role");
  }
  return {
    coordinator_id: stringValue(record.coordinator_id, "coordinator_id"),
    role,
    peer_id: stringValue(record.peer_id, "peer_id"),
    control_addr: stringValue(record.control_addr, "control_addr"),
    addrs: Array.isArray(record.addrs) ? record.addrs.map((item) => stringValue(item, "addrs[]")) : undefined,
    artifact_fetch: true,
    coordinator_url: typeof record.coordinator_url === "string" ? record.coordinator_url : null,
  };
}

function emptyControlNetwork(): ControlNetworkManifest {
  return {
    type: "marshall_control_network",
    version: 1,
    updated_at: new Date(0).toISOString(),
    peers: [],
  };
}

function controlRole(value: unknown, fallback: ControlNetworkPeer["role"]): ControlNetworkPeer["role"] {
  if (value == null || value === "") {
    return fallback;
  }
  if (value === "primary" || value === "mirror" || value === "artifact_provider") {
    return value;
  }
  throw new Error("invalid control network peer role");
}

function splitList(value: string | undefined): string[] {
  if (value == null || value === "") {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function stringValue(value: unknown, field: string, optional = false): string {
  if (typeof value !== "string" || value.length === 0) {
    if (optional) {
      return "";
    }
    throw new Error(`invalid ${field}`);
  }
  return value;
}
