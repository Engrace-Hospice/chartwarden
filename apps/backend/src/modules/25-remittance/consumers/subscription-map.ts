// apps/backend/src/modules/25-remittance/consumers/subscription-map.ts — the §4.4 UPSTREAM outbox-
// subscription map (the M25 inbound catalog). Mirrors the M27 consumers/subscription-map.ts precedent: a
// frozen topic→effect lookup the pure handlers (./handlers.ts) read, and the boot dispatcher (a later
// platform phase — no live relay loop exists yet, RULE 3(d)) forward-declares one binding per topic.
//
// M25 subscribes to three upstream topics: (1) an M23 277CA claim REJECTION seeds a denial worklist row
// before any 835 lands; (2) an M18 EVV-aggregator REJECTION seeds an EVV-back-linked denial; (3) the M22
// render handshake returns a document id M25 records as the appeal-packet / resolution-letter back-ref.
//
// PURE DATA. No I/O, no DB — a frozen table. Cross-module communication is outbox-ONLY: M25 never imports
// M23/M18/M22 internals (the dependency-cruiser blocks it); the topic STRING + the structurally-minimal
// payload shape is the entire contract — this file adds NO new manifest `dependsOn` edge.

/** One M25 effect a delivered upstream event projects to (§4.4). Discriminated by `kind` (additive). */
export type M25SubscriptionEffect =
  /** Seed a denial_case (source=claim_rejection_277ca) from an M23 277CA rejection. */
  | { readonly kind: "seed_denial_from_277ca"; readonly note: string }
  /** Seed a denial_case (source=evv_aggregator_rejection) + back-link the M18 submission. */
  | { readonly kind: "seed_denial_from_evv"; readonly note: string }
  /** Record the M22-returned document id as the appeal-packet / resolution-letter back-reference. */
  | { readonly kind: "document_back_reference"; readonly note: string };

/**
 * The §4.4 catalog: upstream outbox topic → the ordered M25 effects it triggers. Frozen so no consumer can
 * mutate it. The handlers read this map; the boot dispatcher forward-declares one binding per key.
 */
export const M25_SUBSCRIPTION_MAP: Readonly<Record<string, readonly M25SubscriptionEffect[]>> =
  Object.freeze({
    "m23.claim.rejected": [
      {
        kind: "seed_denial_from_277ca",
        note: "A 277CA-derived claim rejection seeds a denial worklist row (deduped on claim+UTC-date).",
      },
    ],
    "m18.evv.aggregator_rejected": [
      {
        kind: "seed_denial_from_evv",
        note: "An EVV-aggregator rejection seeds an EVV-back-linked denial (deduped per submission).",
      },
    ],
    "m22.document.rendered": [
      {
        kind: "document_back_reference",
        note: "The rendered appeal-packet / resolution-letter doc id is recorded as the M25 back-ref.",
      },
    ],
  });

/** The ordered topic list the boot dispatcher forward-declares one consumer binding per (§4.4). */
export const M25_UPSTREAM_SUBSCRIPTIONS = Object.keys(M25_SUBSCRIPTION_MAP) as readonly string[];
