import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { bootstrap } from "@libp2p/bootstrap";
import { identify } from "@libp2p/identify";
import { mdns } from "@libp2p/mdns";
import { ping } from "@libp2p/ping";
import { tcp } from "@libp2p/tcp";
import type { Libp2p, PeerDiscovery } from "@libp2p/interface";
import { createLibp2p } from "libp2p";
import { loadOrCreatePrivateKey } from "./identity.js";

export interface MarshallNodeOptions {
  privateKeyPath: string;
  listen?: string[];
  bootstrapAddrs?: string[];
  enableMdns?: boolean;
}

export async function createMarshallNode(options: MarshallNodeOptions): Promise<Libp2p> {
  const peerDiscovery: Array<(components: any) => PeerDiscovery> = [];

  if (options.bootstrapAddrs?.length) {
    peerDiscovery.push(bootstrap({ list: options.bootstrapAddrs, timeout: 100 }));
  }

  if (options.enableMdns) {
    peerDiscovery.push(mdns());
  }

  return createLibp2p({
    privateKey: await loadOrCreatePrivateKey(options.privateKeyPath),
    addresses: {
      listen: options.listen ?? ["/ip4/127.0.0.1/tcp/0"],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      identify: identify(),
      ping: ping(),
    },
  });
}
