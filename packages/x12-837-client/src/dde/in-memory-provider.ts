// @chartwarden/x12-837-client — the in-memory DdeAccessProvider: the executable SPECIFICATION of the port
// (ADR-0103 D3) and a deterministic double for module tests (queue send routes). TEST SUPPORT ONLY: exported from
// `@chartwarden/x12-837-client/testing`, not the package barrel, so production code cannot pull it in.
//
// All state is partitioned by (organizationId, providerEntityId, usage), the port's isolation boundary.
import { createHash } from "node:crypto";
import { canonical, scopeKey } from "../clearinghouse/submission-identity";
import type { Page } from "../clearinghouse/types";
import { type X12WorkerResult, degraded } from "../types";
import { DDE_DEFAULT_SCOPE, DDE_UNENROLLED_OPERATOR, type DdeHarness } from "./conformance";
import {
  DDE,
  type DdeAccessProvider,
  type DdeContext,
  type DdeDisposition,
  type DdeOperation,
  type DdeOperationStatus,
  type DdeOutcome,
  type DdeReceipt,
  type DdeScope,
} from "./types";

const PAGE_SIZE = 2;
const CURSOR_RE = /^\d+$/;

const ok = <T>(data: T): X12WorkerResult<T> => ({ ok: true, data });
const identityOf = (op: DdeOperation, operatorMembershipId: string): string =>
  createHash("sha256")
    .update(
      canonical({
        operatorMembershipId,
        kind: op.kind,
        controlNumber: op.controlNumber,
        dcn: op.dcn,
        payload: op.payload,
      }),
    )
    .digest("hex");

interface Stored {
  readonly receipt: DdeReceipt;
  readonly identity: string;
}
interface Partition {
  readonly byKey: Map<string, Stored>;
  readonly byRef: Map<string, Stored>;
  readonly outcomes: DdeOutcome[];
}

export interface InMemoryDdeOptions {
  /** Operators with no DDE ID. Defaults to {@link DDE_UNENROLLED_OPERATOR}. */
  readonly unenrolledOperators?: ReadonlySet<string>;
  readonly now?: () => Date;
}

export class InMemoryDdeProvider implements DdeAccessProvider {
  readonly vendor = "in_memory" as const;
  private readonly parts = new Map<string, Partition>();
  private readonly unenrolled: ReadonlySet<string>;
  private readonly now: () => Date;
  private seq = 0;

  constructor(options: InMemoryDdeOptions = {}) {
    this.unenrolled = options.unenrolledOperators ?? new Set([DDE_UNENROLLED_OPERATOR]);
    this.now = options.now ?? (() => new Date());
  }

  private part(scope: DdeScope): Partition {
    const key = scopeKey(scope);
    const existing = this.parts.get(key);
    if (existing) return existing;
    const fresh: Partition = { byKey: new Map(), byRef: new Map(), outcomes: [] };
    this.parts.set(key, fresh);
    return fresh;
  }

  private refuseUnenrolled<T>(ctx: DdeContext): X12WorkerResult<T> | null {
    return this.unenrolled.has(ctx.operatorMembershipId)
      ? degraded<T>(DDE.OPERATOR_NOT_ENROLLED, "the operator has no DDE ID with this provider")
      : null;
  }

  submitOperation(ctx: DdeContext, op: DdeOperation): Promise<X12WorkerResult<DdeReceipt>> {
    const refusal = this.refuseUnenrolled<DdeReceipt>(ctx);
    if (refusal) return Promise.resolve(refusal);
    const empty = op.payload.format === "x12" ? op.payload.x12 === "" : op.payload.document == null;
    if (empty || !op.controlNumber || !op.idempotencyKey) {
      return Promise.resolve(degraded(DDE.INVALID_REQUEST, "the operation is malformed"));
    }
    const p = this.part(ctx);
    const identity = identityOf(op, ctx.operatorMembershipId);
    const prior = p.byKey.get(op.idempotencyKey);
    if (prior) {
      return Promise.resolve(
        prior.identity === identity
          ? ok({ ...prior.receipt, replayed: true })
          : degraded(
              DDE.IDEMPOTENCY_CONFLICT,
              "the idempotency key was reused for a different operation",
            ),
      );
    }
    this.seq += 1;
    const receipt: DdeReceipt = {
      providerReference: `dde-ref-${this.seq}`,
      idempotencyKey: op.idempotencyKey,
      controlNumber: op.controlNumber,
      receivedAt: this.now().toISOString(),
      replayed: false,
    };
    const stored = { receipt, identity };
    p.byKey.set(op.idempotencyKey, stored);
    p.byRef.set(receipt.providerReference, stored);
    return Promise.resolve(ok(receipt));
  }

  fetchOutcomes(
    ctx: DdeContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<DdeOutcome>>> {
    const refusal = this.refuseUnenrolled<Page<DdeOutcome>>(ctx);
    if (refusal) return Promise.resolve(refusal);
    if (cursor !== null && !CURSOR_RE.test(cursor)) {
      return Promise.resolve(
        degraded(DDE.INVALID_REQUEST, "the cursor is not one this provider issued"),
      );
    }
    const all = this.part(ctx).outcomes;
    const start = Math.min(cursor === null ? 0 : Number(cursor), all.length);
    const end = Math.min(start + PAGE_SIZE, all.length);
    return Promise.resolve(
      ok({ items: all.slice(start, end), nextCursor: String(end), hasMore: end < all.length }),
    );
  }

  fetchOperationStatus(
    ctx: DdeContext,
    providerReference: string,
  ): Promise<X12WorkerResult<DdeOperationStatus>> {
    const refusal = this.refuseUnenrolled<DdeOperationStatus>(ctx);
    if (refusal) return Promise.resolve(refusal);
    const p = this.part(ctx);
    if (!p.byRef.has(providerReference)) {
      return Promise.resolve(ok({ providerReference, state: "not_found", latest: null }));
    }
    const latest =
      [...p.outcomes].reverse().find((o) => o.providerReference === providerReference) ?? null;
    return Promise.resolve(
      ok({ providerReference, state: latest?.disposition ?? "received", latest }),
    );
  }

  /** Test-side: play FISS answering an operation. */
  fissAnswers(
    scope: DdeScope,
    providerReference: string,
    disposition: DdeDisposition,
    reasonCodes: readonly string[],
  ): void {
    const p = this.part(scope);
    const stored = p.byRef.get(providerReference);
    if (!stored) throw new Error(`unknown provider reference ${providerReference}`);
    p.outcomes.push({
      eventId: `dde-evt-${p.outcomes.length + 1}`,
      providerReference,
      controlNumber: stored.receipt.controlNumber,
      disposition,
      occurredAt: this.now().toISOString(),
      reasonCodes,
    });
  }
}

export function createInMemoryDdeHarness(
  options: InMemoryDdeOptions = {},
): DdeHarness & { readonly provider: InMemoryDdeProvider } {
  const provider = new InMemoryDdeProvider(options);
  return {
    provider,
    script: {
      fissAnswers: (ref, disposition, reasonCodes, scope) => {
        provider.fissAnswers(scope ?? DDE_DEFAULT_SCOPE, ref, disposition, reasonCodes);
        return Promise.resolve();
      },
    },
  };
}
