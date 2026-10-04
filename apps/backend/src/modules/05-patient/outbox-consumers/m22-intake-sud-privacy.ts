// apps/backend/src/modules/05-patient/outbox-consumers/m22-intake-sud-privacy.ts — M5's half of the DocLens
// SUD-detection round-trip (M22 §7.4 W4 / D8, M5 D10; F-237).
//
//   m22.intake.sud_detected   → add an INTERIM `sud` flag to the patient's privacy snapshot
//                               (`sud_flag_origin = 'm22_intake_unconfirmed'`, W4 step 4)
//   m22.intake.sud_confirmed  → mark that interim flag confirmed (W4 step 6)
//   m22.intake.sud_rejected   → retire the flag — ONLY when DocLens put it there (W4 step 6)
//
// Why the origin column: the snapshot's `sud` flag has two possible authors. M39 consent state puts it there
// when no §2.31 consent is on file (`m39-consent-privacy.ts`); a DocLens detection puts it there for a
// patient M39 has never spoken about. A reviewer rejecting a DocLens false positive must not lift a
// restriction M39's consent state is holding in place, so a rejection touches only an `m22_intake_*` flag.
//
// ONE TRANSACTION per delivery (the read, the decision, the UPSERT and `m5.patient.privacy_flag_changed`).
// Idempotent: each decision is a function of the CURRENT snapshot, so a redelivery that finds the change
// already applied decides "no change" and emits nothing. A null/unknown patient is a silent no-op (the
// convention of every M5 consumer); a malformed payload throws (dead-letter for a human).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  M22_INTAKE_SUD_CONFIRMED_EVENT,
  M22_INTAKE_SUD_DETECTED_EVENT,
  M22_INTAKE_SUD_REJECTED_EVENT,
} from "@wardenx/types";
import { eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { M5OutboxPort } from "../deceased-db";
import type { PrivacyFlag } from "../privacy/index";

const P = schema.patients;
const PFS = schema.patientPrivacyFlagSnapshots;
const CONSUMER_USER_ID = "";

export const M5_INTAKE_SUD_PRIVACY_CONSUMER = {
  eventNames: [
    M22_INTAKE_SUD_DETECTED_EVENT,
    M22_INTAKE_SUD_CONFIRMED_EVENT,
    M22_INTAKE_SUD_REJECTED_EVENT,
  ],
  consumerName: "m5.m22-intake-sud-privacy",
} as const;

export type SudFlagOrigin = "m22_intake_unconfirmed" | "m22_intake_confirmed";

/** The snapshot facts the decision reads. `null` ⇒ the patient has no snapshot row yet. */
export interface SudSnapshotFacts {
  readonly flags: readonly PrivacyFlag[];
  readonly origin: SudFlagOrigin | null;
  /** M39 has spoken about this patient's Part 2 consent (the flag is consent-governed). */
  readonly consentGoverned: boolean;
}

export type SudFlagDecision =
  | { readonly change: false }
  | {
      readonly change: true;
      readonly flags: readonly PrivacyFlag[];
      readonly origin: SudFlagOrigin | null;
    };

const NO_CHANGE: SudFlagDecision = { change: false };

/** Pure — what one W4 event does to the current snapshot. */
export function decideSudFlag(
  eventName: string,
  current: SudSnapshotFacts | null,
): SudFlagDecision {
  const flags = current?.flags ?? [];
  const hasSud = flags.includes("sud");
  const origin = current?.origin ?? null;
  const withSud = (o: SudFlagOrigin): SudFlagDecision => ({
    change: true,
    flags: [...new Set<PrivacyFlag>([...flags, "sud"])].sort(),
    origin: o,
  });
  switch (eventName) {
    case M22_INTAKE_SUD_DETECTED_EVENT:
      // Already restricted (by consent state or an earlier detection): nothing to add.
      if (hasSud) return NO_CHANGE;
      // A §2.31 consent on file lifted the restriction: a detection does not re-impose it.
      if (current?.consentGoverned) return NO_CHANGE;
      return withSud("m22_intake_unconfirmed");
    case M22_INTAKE_SUD_CONFIRMED_EVENT:
      if (hasSud) {
        return origin === "m22_intake_unconfirmed" ? withSud("m22_intake_confirmed") : NO_CHANGE;
      }
      if (current?.consentGoverned) return NO_CHANGE;
      return withSud("m22_intake_confirmed");
    case M22_INTAKE_SUD_REJECTED_EVENT:
      if (!hasSud || origin === null) return NO_CHANGE; // consent-derived, or nothing to retire
      return { change: true, flags: flags.filter((f) => f !== "sud"), origin: null };
    default:
      return NO_CHANGE;
  }
}

function patientIdOf(payload: unknown): string | null | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = (payload as Record<string, unknown>).patientId;
  if (p === null) return null;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

export function buildM5IntakeSudPrivacyConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M5OutboxPort;
}): OutboxConsumerBinding {
  return {
    consumerName: M5_INTAKE_SUD_PRIVACY_CONSUMER.consumerName,
    consumerModule: "m5",
    eventTypes: M5_INTAKE_SUD_PRIVACY_CONSUMER.eventNames,
    async handle(event): Promise<void> {
      const patientId = patientIdOf(event.payload);
      if (patientId === undefined) {
        throw new Error(
          `${M5_INTAKE_SUD_PRIVACY_CONSUMER.consumerName}: '${event.eventType}' payload has no patientId`,
        );
      }
      if (patientId === null) return; // an unresolved batch: no patient to flag
      const organizationId = event.organizationId;
      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [patient] = await tx
            .select({ id: P.id })
            .from(P)
            .where(eq(P.id, patientId))
            .limit(1);
          if (!patient) return;
          const [row] = await tx
            .select({
              flags: PFS.flags,
              invalidatedAt: PFS.invalidatedAt,
              origin: PFS.sudFlagOrigin,
              sourceConsentVersion: PFS.sourceConsentVersion,
            })
            .from(PFS)
            .where(eq(PFS.patientId, patientId))
            .limit(1);
          const current: SudSnapshotFacts | null =
            row && row.invalidatedAt === null
              ? {
                  flags: row.flags as PrivacyFlag[],
                  origin: (row.origin as SudFlagOrigin | null) ?? null,
                  consentGoverned: row.sourceConsentVersion !== null,
                }
              : null;
          const decision = decideSudFlag(event.eventType, current);
          if (!decision.change) return;
          const now = new Date();
          await tx
            .insert(PFS)
            .values({
              patientId,
              organizationId,
              flags: [...decision.flags],
              capturedAt: now,
              sudFlagOrigin: decision.origin,
              invalidatedAt: null,
            })
            .onConflictDoUpdate({
              target: PFS.patientId,
              set: {
                flags: [...decision.flags],
                capturedAt: now,
                sudFlagOrigin: decision.origin,
                invalidatedAt: null,
              },
            });
          await deps.outbox.publish(tx, {
            eventName: "m5.patient.privacy_flag_changed",
            payload: { patientId, organizationId, flags: [...decision.flags] },
            organizationId,
            aggregateKind: "patient",
            aggregateId: patientId,
          });
        },
      );
    },
  };
}
