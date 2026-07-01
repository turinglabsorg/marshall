import type { Libp2p } from "@libp2p/interface";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import { PROTOCOLS } from "./protocols.js";
import {
  InferenceHelloResponseSchema,
  InferenceResponseSchema,
  InferenceStreamEventSchema,
  type InferenceHelloResponse,
  type InferenceRequest,
  type InferenceResponse,
  type InferenceStreamEvent,
} from "./schemas.js";
import { readJsonLines, requestJson, writeJson } from "./wire.js";

type InferenceWorkerStatus = "unknown" | "ready" | "incompatible" | "offline";
type AcceptedHello = Extract<InferenceHelloResponse, { accepted: true }>;

export interface InferenceRouterOptions {
  node: Libp2p;
  workerAddrs: string[];
  model: string;
  adapterId: string;
  adapterHash: string;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
  maxAttempts?: number;
  probeStaleMs?: number;
}

export interface InferenceWorkerSnapshot {
  slot: number;
  status: InferenceWorkerStatus;
  worker_id: string | null;
  peer_id: string | null;
  model: string | null;
  adapter_id: string | null;
  adapter_hash: string | null;
  in_flight: number;
  completed_requests: number;
  failed_requests: number;
  avg_latency_ms: number | null;
  last_seen: string | null;
  last_probe: string | null;
  last_error: string | null;
}

interface InferenceWorkerCandidate {
  slot: number;
  addr: Multiaddr;
  status: InferenceWorkerStatus;
  capabilities?: AcceptedHello;
  inFlight: number;
  completedRequests: number;
  failedRequests: number;
  avgLatencyMs?: number;
  lastSeenMs?: number;
  lastProbeMs?: number;
  lastError?: string;
}

export class InferenceRouter {
  private readonly node: Libp2p;
  private readonly candidates: InferenceWorkerCandidate[];
  private readonly model: string;
  private readonly adapterId: string;
  private readonly adapterHash: string;
  private readonly requestTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxAttempts?: number;
  private readonly probeStaleMs: number;

  constructor(options: InferenceRouterOptions) {
    this.node = options.node;
    this.model = options.model;
    this.adapterId = options.adapterId;
    this.adapterHash = options.adapterHash;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts;
    this.probeStaleMs = options.probeStaleMs ?? 30_000;
    this.candidates = dedupe(options.workerAddrs).map((addr, index) => ({
      slot: index + 1,
      addr: multiaddr(addr),
      status: "unknown",
      inFlight: 0,
      completedRequests: 0,
      failedRequests: 0,
    }));
  }

  get configuredWorkers(): number {
    return this.candidates.length;
  }

  get readyWorkers(): number {
    return this.candidates.filter((candidate) => candidate.status === "ready").length;
  }

  snapshot(): InferenceWorkerSnapshot[] {
    return this.candidates.map((candidate) => snapshot(candidate));
  }

  async refresh(options: { force?: boolean } = {}): Promise<InferenceWorkerSnapshot[]> {
    await Promise.all(this.candidates.map((candidate) => this.probe(candidate, options).catch(() => undefined)));
    return this.snapshot();
  }

  async generate(payload: InferenceRequest): Promise<InferenceResponse> {
    await this.refresh();
    let candidates = this.selectCandidates();
    if (candidates.length === 0) {
      await this.refresh({ force: true });
      candidates = this.selectCandidates();
    }
    if (candidates.length === 0) {
      throw new Error("no compatible inference workers are ready");
    }

    const attempts = this.maxAttempts == null
      ? candidates.length
      : Math.min(this.maxAttempts, candidates.length);
    const errors: string[] = [];

    for (const candidate of candidates.slice(0, attempts)) {
      const startedAt = Date.now();
      candidate.inFlight += 1;
      try {
        const response = InferenceResponseSchema.parse(await requestJson(
          this.node,
          candidate.addr,
          PROTOCOLS.inferenceGenerate,
          payload,
          { timeoutMs: this.requestTimeoutMs },
        ));
        if (!response.accepted) {
          throw new Error(response.error ?? "worker rejected inference request");
        }
        markSuccess(candidate, Date.now() - startedAt);
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`slot ${candidate.slot}: ${message}`);
        markFailure(candidate, message);
      } finally {
        candidate.inFlight -= 1;
      }
    }

    throw new Error(`no inference worker completed request: ${errors.join("; ")}`);
  }

  async generateStream(
    payload: InferenceRequest,
    onEvent: (event: InferenceStreamEvent) => void,
  ): Promise<InferenceResponse> {
    await this.refresh();
    let candidates = this.selectCandidates();
    if (candidates.length === 0) {
      await this.refresh({ force: true });
      candidates = this.selectCandidates();
    }
    if (candidates.length === 0) {
      throw new Error("no compatible inference workers are ready");
    }

    const attempts = this.maxAttempts == null
      ? candidates.length
      : Math.min(this.maxAttempts, candidates.length);
    const errors: string[] = [];

    for (const candidate of candidates.slice(0, attempts)) {
      const startedAt = Date.now();
      candidate.inFlight += 1;
      try {
        const response = await this.streamFromCandidate(candidate, payload, onEvent);
        markSuccess(candidate, Date.now() - startedAt);
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`slot ${candidate.slot}: ${message}`);
        markFailure(candidate, message);
      } finally {
        candidate.inFlight -= 1;
      }
    }

    throw new Error(`no inference worker completed streaming request: ${errors.join("; ")}`);
  }

  private selectCandidates(): InferenceWorkerCandidate[] {
    return this.candidates
      .filter((candidate) => candidate.status === "ready" && isCompatible(candidate.capabilities, this.model, this.adapterId, this.adapterHash))
      .sort((left, right) => {
        if (left.inFlight !== right.inFlight) {
          return left.inFlight - right.inFlight;
        }
        if (left.failedRequests !== right.failedRequests) {
          return left.failedRequests - right.failedRequests;
        }
        return (left.avgLatencyMs ?? 0) - (right.avgLatencyMs ?? 0);
      });
  }

  private async probe(candidate: InferenceWorkerCandidate, options: { force?: boolean }): Promise<void> {
    const now = Date.now();
    if (!options.force && candidate.lastProbeMs != null && now - candidate.lastProbeMs < this.probeStaleMs) {
      return;
    }
    candidate.lastProbeMs = now;
    try {
      const response = InferenceHelloResponseSchema.parse(await requestJson(
        this.node,
        candidate.addr,
        PROTOCOLS.inferenceHello,
        { type: "marshall_inference_hello_request" },
        { timeoutMs: this.probeTimeoutMs },
      ));
      if (!response.accepted) {
        throw new Error(response.error ?? "worker rejected hello");
      }
      candidate.capabilities = response;
      candidate.lastSeenMs = Date.now();
      if (isCompatible(response, this.model, this.adapterId, this.adapterHash)) {
        candidate.status = "ready";
        candidate.lastError = undefined;
      } else {
        candidate.status = "incompatible";
        candidate.lastError = `worker serves ${response.model}/${response.adapter_id}/${response.adapter_hash}`;
      }
    } catch (error) {
      candidate.status = "offline";
      candidate.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async streamFromCandidate(
    candidate: InferenceWorkerCandidate,
    payload: InferenceRequest,
    onEvent: (event: InferenceStreamEvent) => void,
  ): Promise<InferenceResponse> {
    const stream = await this.node.dialProtocol(candidate.addr, PROTOCOLS.inferenceGenerateStream, {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    await writeJson(stream, payload);
    let completed: InferenceResponse | null = null;
    for await (const value of readJsonLines(stream)) {
      const event = InferenceStreamEventSchema.parse(value);
      onEvent(event);
      if (event.event === "error") {
        throw new Error(event.error);
      }
      if (event.event === "completed") {
        completed = {
          type: "marshall_inference_response",
          accepted: true,
          peer_id: event.peer_id ?? candidate.capabilities?.peer_id ?? "",
          worker_id: event.worker_id ?? candidate.capabilities?.worker_id,
          model: event.model ?? candidate.capabilities?.model,
          adapter_id: event.adapter_id ?? candidate.capabilities?.adapter_id,
          adapter_hash: event.adapter_hash ?? candidate.capabilities?.adapter_hash,
          prompt: event.prompt,
          text: event.text,
          raw_text: event.raw_text,
          elapsed_ms: event.elapsed_ms,
        };
      }
    }
    if (completed == null) {
      throw new Error("worker stream closed without completed event");
    }
    return InferenceResponseSchema.parse(completed);
  }
}

function isCompatible(
  capabilities: AcceptedHello | undefined,
  model: string,
  adapterId: string,
  adapterHash: string,
): boolean {
  return capabilities != null
    && capabilities.model === model
    && capabilities.adapter_id === adapterId
    && capabilities.adapter_hash === adapterHash;
}

function markSuccess(candidate: InferenceWorkerCandidate, elapsedMs: number): void {
  candidate.status = "ready";
  candidate.completedRequests += 1;
  candidate.lastSeenMs = Date.now();
  candidate.lastError = undefined;
  candidate.avgLatencyMs = candidate.avgLatencyMs == null
    ? elapsedMs
    : Math.round(candidate.avgLatencyMs * 0.8 + elapsedMs * 0.2);
}

function markFailure(candidate: InferenceWorkerCandidate, message: string): void {
  candidate.failedRequests += 1;
  candidate.lastError = message;
}

function snapshot(candidate: InferenceWorkerCandidate): InferenceWorkerSnapshot {
  return {
    slot: candidate.slot,
    status: candidate.status,
    worker_id: candidate.capabilities?.worker_id ?? null,
    peer_id: candidate.capabilities?.peer_id ?? null,
    model: candidate.capabilities?.model ?? null,
    adapter_id: candidate.capabilities?.adapter_id ?? null,
    adapter_hash: candidate.capabilities?.adapter_hash ?? null,
    in_flight: candidate.inFlight,
    completed_requests: candidate.completedRequests,
    failed_requests: candidate.failedRequests,
    avg_latency_ms: candidate.avgLatencyMs ?? null,
    last_seen: candidate.lastSeenMs == null ? null : new Date(candidate.lastSeenMs).toISOString(),
    last_probe: candidate.lastProbeMs == null ? null : new Date(candidate.lastProbeMs).toISOString(),
    last_error: candidate.lastError ?? null,
  };
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
