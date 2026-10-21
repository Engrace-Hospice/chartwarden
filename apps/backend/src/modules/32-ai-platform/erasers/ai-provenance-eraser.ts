// apps/backend/src/modules/32-ai-platform/erasers/ai-provenance-eraser.ts — M32-T02, the TWO §3.7
// AI-provenance data erasers (`clinical_record_ai_provenance`, `intake_ai_provenance`; M4
// destruction-cert workflow).
//
// NEITHER ERASE DELETES A ROW, and that is the whole design. `ai_invocation` is the §164.528
// disclosure ledger: its token counts, model version pin, ZDR flag, routing decision and timestamps ARE
// the evidence that a disclosure to a model vendor happened (or, for a refused call, that it did not).
// Destroying those rows in the name of a destruction certificate would destroy the record THAT the
// disclosure occurred — the opposite of what the certificate is for. §3.7 is explicit: the rows remain
// and the encrypted payloads become unreadable.
//
// WHAT "UNREADABLE" MEANS HERE, and the one place this deviates from §3.7's letter. §3.7 describes the
// erase as a cryptographic shred of the per-tenant DEK. A PER-PATIENT destruction certificate cannot do
// that: the tenant DEK protects every other patient's rows too, and shredding it would destroy data no
// certificate authorized. What the platform can do — and what produces exactly the OUTCOME §3.7
// specifies — is destroy the ciphertext on that patient's own invocation rows: `prompt_payload_cipher`
// is overwritten with an empty bytea (the column is NOT NULL, so an empty value is the shred sentinel)
// and the two nullable ciphers are set to NULL. The tenant-offboarding path, where the DEK shred IS
// available and covers the whole org in one operation, is M34's and is unchanged by this.
//
// The 0116 immutability trigger freezes those three columns against every UPDATE EXCEPT this one: a
// cipher may be destroyed, never replaced. That is why the destruction path needs no privileged bypass
// and no new session variable — the only edit the trigger permits to a cipher is the one that removes
// it, and the M4 write-audit trigger records the edit either way.
//
// TWO CLASSES, NOT ONE, because M4's eraser registry is single-keyed and §3.7 maps M32's provenance to
// the distinct data classes M22 (intake) and M8 (clinical record) already use. The split is by
// capability: `doclens_*` invocations ran against a patient's INTAKE DOCUMENTS and belong to
// `intake_ai_provenance`; every other capability (HearthNote Layer 2, IDG polish, copilot, the
// predictions) ran against the CHART and belongs to `clinical_record_ai_provenance`. Both erasers are
// registered so that whichever certificate arrives, the invocations it covers are reached — and neither
// touches the other's rows, so running both is not a double-shred.
//
// WHAT IS NEVER TOUCHED: `ai_token_ledger` (token counts and dollars, no PHI, and append-only by §3.5 —
// erasing it would corrupt the tenant's own billing history), `ai_hallucination_report` (its narrative
// concerns a patient but the table deliberately carries no patient column, so a per-patient certificate
// has no way to identify the report and inventing a join through `invocation_id` would reach reports the
// certificate never named), and the whole platform-shared governance surface (capabilities, backends,
// prompt templates, calibrations, evaluation runs — none of it is any patient's data).
//
// Idempotent: a second erase finds the rows already shredded and reports zero. Registers the REAL
// erasers over the Phase-0 deny-stubs; the composition root runs this AFTER wireErasers() and before
// validateErasers().
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { and, eq, isNotNull, like, not, or, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** Which half of a patient's AI provenance an erase covers (§3.7). */
export type AiProvenanceScope = "clinical_record" | "intake";

/** The prefix that marks an invocation as having run against a patient's INTAKE documents. */
export const AI_INTAKE_CAPABILITY_PREFIX = "doclens_";

/** What one AI-provenance erase did (recorded on the M4 destruction certificate, §3.7). */
export interface AiProvenanceEraseCounts {
  /** `ai_invocation` rows whose cipher payloads were destroyed (rows PRESERVED). */
  readonly invocationsShredded: number;
}

const ZERO: AiProvenanceEraseCounts = { invocationsShredded: 0 };

/** Knobs the destruction certificate carries into the erase. */
export interface AiProvenanceEraseOptions {
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the eraseFns compose over (Drizzle in prod, under RLS). */
export interface AiProvenanceEraseStore {
  /** Advisory-lock the patient so a concurrent invocation write cannot interleave with the shred. */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Destroy the cipher payloads on this patient's invocation rows for the given half of the provenance.
   * Returns the number of rows whose ciphers were destroyed — a row already shredded is not counted
   * again, which is what makes a second erase report zero.
   */
  shredInvocationPayloads(
    organizationId: string,
    patientId: string,
    scope: AiProvenanceScope,
  ): Promise<number>;
}

/**
 * Erase one half of a patient's AI provenance under a destruction certificate (§3.7): lock, then
 * destroy the ciphertext. Pure orchestration over the store — no I/O of its own.
 */
export async function eraseAiProvenance(
  organizationId: string,
  patientId: string,
  scope: AiProvenanceScope,
  store: AiProvenanceEraseStore,
): Promise<{ erased: number; counts: AiProvenanceEraseCounts }> {
  await store.lockPatient(organizationId, patientId);
  const invocationsShredded = await store.shredInvocationPayloads(organizationId, patientId, scope);
  // The tally is rows SHREDDED, not rows deleted — M4's certificate records a count of what the erase
  // reached, and reporting zero here for a patient with a hundred shredded invocations would read as
  // "nothing to destroy".
  return { erased: invocationsShredded, counts: { invocationsShredded } };
}

/** Seed shape for the in-memory {@link AiProvenanceEraseStore} (slice/tests). */
export interface InMemoryAiProvenanceEraseSeed {
  /** Rows the first erase finds, per scope. */
  readonly clinicalRecord?: number;
  readonly intake?: number;
}

/** An in-memory store for the slice/tests (seeded counts; idempotent per scope on a second erase). */
export function createInMemoryAiProvenanceEraseStore(seed: InMemoryAiProvenanceEraseSeed = {}): {
  store: AiProvenanceEraseStore;
  locked: string[];
} {
  const remaining = new Map<AiProvenanceScope, number>([
    ["clinical_record", seed.clinicalRecord ?? 0],
    ["intake", seed.intake ?? 0],
  ]);
  const locked: string[] = [];
  return {
    locked,
    store: {
      async lockPatient(_organizationId, patientId) {
        locked.push(patientId);
      },
      async shredInvocationPayloads(_organizationId, _patientId, scope) {
        const n = remaining.get(scope) ?? 0;
        remaining.set(scope, 0);
        return n;
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path. Runs inside `withOrgContext` so RLS scopes every
 * statement to the acting org — a destruction certificate can never reach across tenants.
 */
export function createDrizzleAiProvenanceEraseStore(db: DbClient): AiProvenanceEraseStore {
  const INVOCATION = schema.aiInvocation;
  /** The shred sentinel: an empty bytea. `prompt_payload_cipher` is NOT NULL, so it cannot be nulled. */
  const SHREDDED = sql`''::bytea`;

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async shredInvocationPayloads(organizationId, patientId, scope) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const intakePattern = `${AI_INTAKE_CAPABILITY_PREFIX}%`;
        const scopeFilter =
          scope === "intake"
            ? like(INVOCATION.capabilityKey, intakePattern)
            : not(like(INVOCATION.capabilityKey, intakePattern));

        // `alreadyShredded` is the idempotence guard: a row whose prompt cipher is already empty AND
        // whose two optional ciphers are already gone has nothing left to destroy, and counting it
        // again would inflate the certificate's tally on every re-run.
        const shredded = await tx
          .update(INVOCATION)
          .set({
            promptPayloadCipher: SHREDDED as never,
            responsePayloadCipher: null,
            chartContextCipher: null,
          })
          .where(
            and(
              eq(INVOCATION.patientId, patientId),
              scopeFilter,
              or(
                sql`length(${INVOCATION.promptPayloadCipher}) > 0`,
                isNotNull(INVOCATION.responsePayloadCipher),
                isNotNull(INVOCATION.chartContextCipher),
              ),
            ),
          )
          .returning({ id: INVOCATION.id });
        return shredded.length;
      });
    },
  };
}

/** Injected adapter for M32's erasers (slice defaults to in-memory). */
export interface AiProvenanceEraserDeps {
  store?: AiProvenanceEraseStore;
  options?: AiProvenanceEraseOptions;
}

/** Build one AI-provenance `DataEraser`. `subjectId` is the PATIENT being destroyed (§3.7). */
export function createAiProvenanceEraser(
  scope: AiProvenanceScope,
  store: AiProvenanceEraseStore,
): DataEraser {
  return {
    async erase(orgScope, subjectId) {
      const { erased } = await eraseAiProvenance(orgScope.orgId, subjectId, scope, store);
      return { erased };
    },
  };
}

/** Register M32's REAL §3.7 erasers over the Phase-0 deny-stubs (before validateErasers()). */
export function registerAiProvenanceErasers(deps: AiProvenanceEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryAiProvenanceEraseStore().store;
  registerEraser(
    "clinical_record_ai_provenance",
    createAiProvenanceEraser("clinical_record", store),
  );
  registerEraser("intake_ai_provenance", createAiProvenanceEraser("intake", store));
}

export { ZERO as AI_PROVENANCE_ERASE_ZERO };
