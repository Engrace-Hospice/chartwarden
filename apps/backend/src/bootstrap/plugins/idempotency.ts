// apps/backend/src/bootstrap/plugins/idempotency.ts — M1 idempotency HTTP middleware
// (spec §4.6 / W-M1-10 / SEC-025; M1-T10).
//
// This is the HTTP wrapper the `@wardenx/shared` idempotency helper's docstring promised
// "is wired in M1-T10": it reuses that leaf's request fingerprint (computeIdempotencyHash
// = SHA-256 over org + key + body) and its injected IdempotencyStore port (Valkey /
// Postgres `idempotency_key`), so the HTTP layer adds NO direct schema write.
//
// Contract (spec §4.6): only guards mutating methods carrying an `Idempotency-Key`; skips
// unauthenticated routes (no org scope to key on). A first request records a `pending`
// lock then captures its response on the way out (onSend) and marks it `complete`. A replay
// with the SAME body returns the cached response; a DIFFERENT body is a 409
// IDEMPOTENCY_CONFLICT; a concurrent duplicate still in flight is a 409 CONFLICT.
import {
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotentResponse,
  computeIdempotencyHash,
} from "@wardenx/shared";
import { ConflictError, IdempotencyConflictError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Opt this route out of `Idempotency-Key` capture. For a response that carries a one-time secret
     * (GAP-020: the wristband token): it must never reach `idempotency_key.response_body`.
     */
    noIdempotencyCapture?: boolean;
  }
}

/** Per-request marker: a `pending` lock this request opened and must `complete` on send. */
const pendingCaptures = new WeakMap<FastifyRequest, { orgId: string; key: string }>();

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export function applyIdempotency(app: FastifyInstance, store: IdempotencyStore): void {
  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    // A route that returns a ONE-TIME SECRET (GAP-020: the wristband token) opts out: its response must never be
    // copied into `idempotency_key.response_body`, even though the shared web client sends a key on every mutation.
    // It has no pending claim, so `onSend` below captures nothing. Its double-submit safety is its own precondition.
    if (request.routeOptions?.config?.noIdempotencyCapture === true) return;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) return;
    const orgId = request.context?.organizationId;
    if (!orgId) return; // unauthenticated route — nothing to scope the key by

    // The fingerprint also binds the CALLER: a key reused by a different user in the same org is a conflict (409), never a
    // replay of the first user's cached response (which for e.g. a billing override echoes the typed rationale), and it
    // is answered before any route-level permission guard runs.
    const requestHash = computeIdempotencyHash(
      `${orgId}|${request.context?.userId ?? ""}`,
      key,
      request.body ?? null,
    );
    const answerFrom = (existing: IdempotencyRecord) => {
      if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
      if (existing.state === "complete") {
        const status = Number(existing.response.status) || 200;
        return reply.code(status).send(existing.response.body);
      }
      // Still `pending` — a concurrent duplicate arrived before the first finished.
      throw new ConflictError("Idempotency-Key request is still being processed");
    };

    const existing = await store.load(orgId, key);
    if (existing) return answerFrom(existing);

    // The claim is the serialization point (GAP-007): `load` returning null does not mean we own
    // the key, only that nobody did a moment ago. Only the caller whose `putPending` wins runs the
    // handler; a loser reloads the winner's record and replays it or reports it in flight.
    if (!(await store.putPending(orgId, key, requestHash))) {
      const winner = await store.load(orgId, key);
      if (winner) return answerFrom(winner);
      // The record vanished between the lost claim and the reload (swept or expired in between):
      // fail safe — never run the handler without the claim; the client retries.
      throw new ConflictError("Idempotency-Key request is still being processed");
    }
    pendingCaptures.set(request, { orgId, key });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const marker = pendingCaptures.get(request);
    if (!marker) return payload;
    pendingCaptures.delete(request);
    const response: IdempotentResponse = {
      status: String(reply.statusCode),
      body: parsePayload(payload),
    };
    // BOOKKEEPING MUST NOT REWRITE THE OUTCOME (F-073, #182). By `onSend` the handler has already
    // COMMITTED; letting a store error escape turns a write that happened into a 500 that says it
    // did not — which is exactly what a bodiless 204 did on the production store, verified live: the
    // row was gone and the UI reported failure. Worse, the client mints a fresh key per request, so
    // the user's retry runs under a NEW key and re-executes — the mechanism that exists to prevent
    // double-execution causing it.
    //
    // The failure is logged, never swallowed silently, and the record is left `pending`: a retry
    // under the SAME key then answers 409 rather than re-running, so duplicate prevention still
    // fails safe. Reporting the truth about the write is the property worth keeping here.
    try {
      await store.complete(marker.orgId, marker.key, response);
    } catch (error) {
      request.log.error(
        { err: error, idempotencyKey: marker.key },
        "idempotency: could not record the completed response; the write itself succeeded and the key stays pending",
      );
    }
    return payload;
  });
}

/** How long an in-memory record stays replayable; mirrors the Postgres store's TTL (§3.10). */
const IN_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

export interface InMemoryIdempotencyStoreOptions {
  readonly ttlMs?: number;
  /** Injectable clock (epoch ms) so expiry is testable without sleeping. */
  readonly now?: () => number;
}

/**
 * In-memory IdempotencyStore — the slice default (single instance). `putPending` is the atomic
 * claim (check-and-set with no await between), so concurrent duplicates serialize: exactly one
 * caller gets `true`. An expired record is absent to `load` and is reclaimed by `putPending`.
 * Production injects the Postgres-backed store with the same contract. Exported for boot wiring + tests.
 */
export function createInMemoryIdempotencyStore(
  options: InMemoryIdempotencyStoreOptions = {},
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? IN_MEMORY_TTL_MS;
  const now = options.now ?? Date.now;
  type Entry = { record: IdempotencyRecord; expiresAt: number };
  const entries = new Map<string, Entry>();
  const k = (orgId: string, key: string) => `${orgId} ${key}`;
  const live = (orgId: string, key: string): Entry | undefined => {
    const entry = entries.get(k(orgId, key));
    return entry && entry.expiresAt > now() ? entry : undefined;
  };
  return {
    async load(orgId, key) {
      return live(orgId, key)?.record ?? null;
    },
    async putPending(orgId, key, requestHash) {
      if (live(orgId, key)) return false;
      entries.set(k(orgId, key), {
        record: { state: "pending", requestHash },
        expiresAt: now() + ttlMs,
      });
      return true;
    },
    async complete(orgId, key, response) {
      const existing = live(orgId, key);
      // Only the claim holder completes a pending record (mirrors the Postgres store's narrowing).
      if (existing?.record.state !== "pending") return;
      entries.set(k(orgId, key), {
        record: { state: "complete", requestHash: existing.record.requestHash, response },
        expiresAt: existing.expiresAt,
      });
    },
  };
}
