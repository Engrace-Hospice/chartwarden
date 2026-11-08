import { type DbClient, schema } from "@chartwarden/db";
import { decodeKeysetCursor, encodeCursor } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { DegradedError } from "@chartwarden/types";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { ClaimMdProtectedPayloadCipher } from "../../../bootstrap/claimmd-payload-cipher";
import type { M25ReadActor } from "../routes/actor";

/** A page of review items plus the next signed cursor (null at the end). */
interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}
import { providerEntityScopeCondition } from "../routes/scope";

const STAGE = schema.claimmdEraM25Stage;
const PAGE_MAX = 100;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export interface ClaimMdEraReviewItem {
  readonly id: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly eraId: string;
  readonly fileIndex: number;
  readonly state: string;
  readonly holdReason: string | null;
  readonly possibleDuplicate: boolean;
  readonly existingAdviceId: string | null;
  readonly createdAt: string;
  readonly detailsAvailable: boolean;
  readonly payer: { readonly name: string | null; readonly identifier: string | null };
  readonly payee: { readonly name: string | null; readonly npi: string | null };
  readonly payment: {
    readonly trace: string | null;
    readonly method: string | null;
    readonly amount: number | null;
    readonly date: string | null;
  };
  readonly claims: readonly JsonRecord[];
  readonly providerAdjustments: readonly JsonRecord[];
  readonly claimOutcomes: readonly JsonRecord[];
  readonly reconciliationEligible: boolean;
}

interface StoredStage {
  id: string;
  organizationId: string;
  providerEntityId: string;
  locationId: string | null;
  sourceInboxId: string;
  idempotencyKey: string | null;
  protectedDetailsCipher: string | null;
  state: string;
  safeReasonCode: string | null;
  possibleDuplicateAdviceId: string | null;
  eraId: string;
  fileIndex: number;
  createdAt: Date | string;
}

export function projectClaimMdEraReviewItem(
  row: StoredStage,
  cipher: ClaimMdProtectedPayloadCipher,
): ClaimMdEraReviewItem {
  let details: JsonRecord | null = null;
  if (row.protectedDetailsCipher && row.idempotencyKey) {
    try {
      const plaintext = cipher.open(
        row.sourceInboxId,
        row.idempotencyKey,
        Buffer.from(row.protectedDetailsCipher, "base64"),
      );
      const parsed: unknown = JSON.parse(plaintext);
      if (record(parsed)) details = parsed;
    } catch {
      throw new DegradedError(
        "M25 Claim.MD ERA review",
        "protected remittance details are unavailable",
      );
    }
  }
  const advice = record(details?.transactionSet) ? details.transactionSet : {};
  const payer = record(advice.payer) ? advice.payer : {};
  const payee = record(advice.payee) ? advice.payee : {};
  const claims = array(advice.claims)
    .filter(record)
    .map((claim) => ({
      patientControlNumber: str(claim.patientControlNumber),
      payerIcn: str(claim.payerIcn),
      statusCode: num(claim.statusCode),
      totalCharge: num(claim.totalCharge),
      totalPayment: num(claim.totalPayment),
      patientResponsibility: num(claim.patientResponsibility),
      serviceFrom: str(claim.serviceFrom),
      serviceTo: str(claim.serviceTo),
      adjustments: array(claim.adjustments)
        .filter(record)
        .map(({ groupCode, reasonCode, amount, quantity }) => ({
          groupCode: str(groupCode),
          reasonCode: str(reasonCode),
          amount: num(amount),
          quantity: num(quantity),
        })),
      serviceLines: array(claim.serviceLines)
        .filter(record)
        .map((line) => ({
          procedureCode: str(line.procedureCode),
          revenueCode: str(line.revenueCode),
          chargeAmount: num(line.chargeAmount),
          paidAmount: num(line.paidAmount),
          paidUnits: num(line.paidUnits),
          submittedUnits: num(line.submittedUnits),
          adjustments: array(line.adjustments)
            .filter(record)
            .map(({ groupCode, reasonCode, amount, quantity }) => ({
              groupCode: str(groupCode),
              reasonCode: str(reasonCode),
              amount: num(amount),
              quantity: num(quantity),
            })),
          remarks: array(line.remarks)
            .filter(record)
            .map((remark) => ({ kind: str(remark.kind), code: str(remark.code) })),
        })),
      remarks: array(claim.remarks)
        .filter(record)
        .map((remark) => ({ kind: str(remark.kind), code: str(remark.code) })),
    }));
  const outcomes = array(details?.claimOutcomes)
    .filter(record)
    .map((outcome) => ({
      claimId: str(outcome.claimId),
      outcome: str(outcome.outcome),
      module: str(outcome.module),
      fileIndex: num(outcome.fileIndex),
      transactionSetControlNumber: str(outcome.transactionSetControlNumber),
    }));
  const date =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString();
  return {
    id: row.id,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    eraId: row.eraId,
    fileIndex: row.fileIndex,
    state: row.state,
    holdReason: row.safeReasonCode,
    possibleDuplicate:
      row.state === "possible_duplicate" ||
      row.safeReasonCode === "POSSIBLE_CROSS_SOURCE_DUPLICATE",
    existingAdviceId: row.possibleDuplicateAdviceId,
    createdAt: date,
    detailsAvailable: details !== null,
    payer: { name: str(payer.name), identifier: str(payer.id) },
    payee: { name: str(payee.name), npi: payee.idQualifier === "XX" ? str(payee.id) : null },
    payment: {
      trace: str(advice.checkOrEftTraceNumber),
      method: str(advice.paymentMethod),
      amount: num(advice.totalPaymentAmount),
      date: str(advice.productionDate),
    },
    claims,
    providerAdjustments: array(advice.providerAdjustments)
      .filter(record)
      .map(({ reason, reference, amount }) => ({
        reason: str(reason),
        reference: str(reference),
        amount: num(amount),
      })),
    claimOutcomes: outcomes,
    reconciliationEligible: row.state === "staged" && details !== null,
  };
}

export interface ClaimMdEraReviewService {
  list(
    actor: M25ReadActor,
    filters: { providerEntityId?: string; state?: string },
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<ClaimMdEraReviewItem>>;
  get(actor: M25ReadActor, id: string): Promise<ClaimMdEraReviewItem | null>;
}

/** M25-owned tenant read. It never reads central inbox tables and has no financial write dependency. */
export function buildDrizzleClaimMdEraReviewService(
  db: DbClient,
  cipher: ClaimMdProtectedPayloadCipher,
): ClaimMdEraReviewService {
  return {
    async list(actor, filters, rawCursor, requestedLimit) {
      const cursor = decodeKeysetCursor(actor.organizationId, rawCursor, "instant");
      const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(requestedLimit)));
      const rows = await withOrgContext(db, actor, async (tx) =>
        tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(
                STAGE.providerEntityId,
                actor.providerEntityScope,
                filters.providerEntityId,
              ),
              filters.state ? eq(STAGE.state, filters.state) : undefined,
              cursor
                ? or(
                    lt(STAGE.createdAt, new Date(cursor.a)),
                    and(eq(STAGE.createdAt, new Date(cursor.a)), lt(STAGE.id, cursor.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(STAGE.createdAt), desc(STAGE.id))
          .limit(limit + 1),
      );
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit) as StoredStage[];
      const items = selected.map((row) => projectClaimMdEraReviewItem(row, cipher));
      const last = selected.at(-1);
      return {
        items,
        nextCursor:
          hasMore && last
            ? encodeCursor(actor.organizationId, {
                a:
                  last.createdAt instanceof Date
                    ? last.createdAt.toISOString()
                    : new Date(last.createdAt).toISOString(),
                id: last.id,
              })
            : null,
      };
    },
    async get(actor, id) {
      const [row] = await withOrgContext(db, actor, (tx) =>
        tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.organizationId, actor.organizationId),
              eq(STAGE.id, id),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1),
      );
      return row ? projectClaimMdEraReviewItem(row as StoredStage, cipher) : null;
    },
  };
}
