export const PROTOCOLS = {
  workerRegister: "/marshall/worker/register/1.0.0",
  workerHeartbeat: "/marshall/worker/heartbeat/1.0.0",
  jobOffer: "/marshall/job/offer/1.0.0",
  jobClaim: "/marshall/job/claim/1.0.0",
  jobStatus: "/marshall/job/status/1.0.0",
  artifactManifest: "/marshall/artifact/manifest/1.0.0",
  artifactFetch: "/marshall/artifact/fetch/1.0.0",
  inferenceGenerate: "/marshall/inference/generate/1.0.0",
} as const;

export type ProtocolName = (typeof PROTOCOLS)[keyof typeof PROTOCOLS];
