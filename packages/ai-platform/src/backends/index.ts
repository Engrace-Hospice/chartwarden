// @wardenx/ai-platform — §2.3 / D1 / §8.4 model backends (M32-T04).
//
//   · ./model-backend   the pluggable `ModelBackend` port + its registry
//   · ./anthropic       the vendor adapter and its D19 ZDR constructor invariant
//
// The Ollama-hosted local backends and the ml-worker classifier land with the `ml-worker` /
// `embeddings-worker` sidecars; they implement the same port and, per the vendor-adapter mandate, their
// HTTP clients live in this package too.
export * from "./model-backend";
export * from "./anthropic";
