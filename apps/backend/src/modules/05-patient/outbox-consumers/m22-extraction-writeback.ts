// apps/backend/src/modules/05-patient/outbox-consumers/m22-extraction-writeback.ts — the LIVE
// `m22.extraction.commit_requested` consumer: M5's half of the DocLens chart-writeback handshake
// (M22 §7.1 W1 steps 11–12, M5 §4.6; F-235, #248).
//
// SCOPE (F-231 decisions A1 + B, see `@chartwarden/types` doclens-writeback.ts): a DEMOGRAPHICS UPDATE on an
// EXISTING patient — the one the intake batch was resolved to — limited to the low-risk contact allowlist
// (`DOCLENS_M5_WRITEBACK_FIELDS`). The M22 review is the clinician accept step, exactly as M29's review
// queue is for an HL7 proposal (§4.10); this is never a headless patient create, never touches legal name /
// DOB / sex / identifiers / status, and never displaces a primary contact or address (every row it adds
// is `is_primary=false`, the PatientMutator D5 rule).
//
// ONE TRANSACTION: the chart rows, `m5.patient.updated` (when anything was written) and the
// `m5.patient.draft_created_from_extraction` reply all commit together or not at all.
//
// IDEMPOTENT BY CONTENT. Each value is written only if the patient does not already hold that exact value
// (same phone kind+E.164, same lower-cased email, same preferred name, same current address). A redelivery
// after a crash between handle() and the dispatcher's receipt therefore writes nothing new and reports
// `already_present` — the same outcome a fax repeating a known contact gets. The reply is re-emitted; M22's
// back-ref consumer stamps only unstamped provenance, so its terminal event is not duplicated.
//
// FAIL DIRECTIONS: malformed / cross-tenant payload, unknown patient, or a MERGED patient THROW (retry →
// DLQ — a writeback aimed at a merged chart needs a human, not a redirect guess). A single field that
// cannot be normalized (a phone that is not a NANP/E.164 number, an incomplete address) is SKIPPED with a
// reason and reported back; the rest of the commit still applies.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  DOCLENS_M5_WRITEBACK_FIELDS,
  type DocLensFieldOutcome,
  type DocLensM5WritebackSlot,
  type DraftCreatedFromExtractionPayload,
  type ExtractionCommitRequestedPayload,
  M5_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M22_EXTRACTION_COMMIT_REQUESTED_EVENT,
} from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { M5OutboxPort } from "../deceased-db";

const P = schema.patients;
const ADDR = schema.patientAddresses;
const PHONE = schema.patientPhones;
const EMAIL = schema.patientEmails;
const ALIAS = schema.patientNameAliases;

export const M5_EXTRACTION_WRITEBACK_CONSUMER = {
  eventName: M22_EXTRACTION_COMMIT_REQUESTED_EVENT,
  consumerName: "m5.extraction-writeback",
} as const;

// ── pure: payload → normalized plan ─────────────────────────────────────────────────────────────────────

export interface NormalizedAddress {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

export interface ExtractionWritebackPlan {
  readonly preferredName?: { readonly fieldPath: string; readonly value: string };
  readonly phones: ReadonlyArray<{
    readonly fieldPath: string;
    readonly kind: "home" | "mobile";
    readonly e164: string;
  }>;
  readonly email?: { readonly fieldPath: string; readonly value: string };
  readonly address?: { readonly fieldPaths: readonly string[]; readonly value: NormalizedAddress };
  readonly skipped: ReadonlyArray<Extract<DocLensFieldOutcome, { outcome: "skipped" }>>;
}

const collapse = (v: string): string => v.trim().replace(/\s+/g, " ");

/** NANP 10-digit, `1`+10 digits, or an explicit `+` E.164 (8–15 digits). Anything else is not a phone. */
export function normalizePhoneE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Map the commit's fields onto the allowlisted slots, normalizing each; skip (never guess) the rest. */
export function planExtractionWriteback(
  fields: ExtractionCommitRequestedPayload["fields"],
): ExtractionWritebackPlan {
  const skipped: Array<Extract<DocLensFieldOutcome, { outcome: "skipped" }>> = [];
  const skip = (fieldPath: string, reason: string): void => {
    skipped.push({ fieldPath, outcome: "skipped", reason });
  };
  const bySlot = new Map<DocLensM5WritebackSlot, { fieldPath: string; value: string }>();
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.fieldPath)) {
      skip(f.fieldPath, "duplicate_field");
      continue;
    }
    seen.add(f.fieldPath);
    // Defense in depth: M22 already applied this allowlist; M5 re-checks it on receipt (A1 + B).
    const slot = Object.hasOwn(DOCLENS_M5_WRITEBACK_FIELDS, f.fieldPath)
      ? DOCLENS_M5_WRITEBACK_FIELDS[f.fieldPath]
      : undefined;
    if (slot === undefined) {
      skip(f.fieldPath, "not_allowlisted");
      continue;
    }
    bySlot.set(slot, { fieldPath: f.fieldPath, value: f.value });
  }

  let preferredName: ExtractionWritebackPlan["preferredName"];
  const pn = bySlot.get("preferredName");
  if (pn) {
    const v = collapse(pn.value);
    if (v.length === 0 || v.length > 200) skip(pn.fieldPath, "preferred_name_invalid");
    else preferredName = { fieldPath: pn.fieldPath, value: v };
  }

  const phones: Array<ExtractionWritebackPlan["phones"][number]> = [];
  for (const [slot, kind] of [
    ["phoneHome", "home"],
    ["phoneMobile", "mobile"],
  ] as const) {
    const ph = bySlot.get(slot);
    if (!ph) continue;
    const e164 = normalizePhoneE164(ph.value);
    if (e164 === null) skip(ph.fieldPath, "phone_not_normalizable");
    else phones.push({ fieldPath: ph.fieldPath, kind, e164 });
  }

  let email: ExtractionWritebackPlan["email"];
  const em = bySlot.get("email");
  if (em) {
    const v = em.value.trim().toLowerCase();
    if (v.length > 254 || !EMAIL_RE.test(v)) skip(em.fieldPath, "email_invalid");
    else email = { fieldPath: em.fieldPath, value: v };
  }

  // Address: all-or-nothing on the D5 core (line1, city, state, postal) — never a half-row.
  let address: ExtractionWritebackPlan["address"];
  const addrSlots = [
    "address.line1",
    "address.line2",
    "address.city",
    "address.state",
    "address.postalCode",
  ] as const;
  const addrParts = addrSlots.map((s) => bySlot.get(s));
  const addrPaths = addrParts.flatMap((p) => (p ? [p.fieldPath] : []));
  if (addrPaths.length > 0) {
    const [line1, line2, city, state, postal] = addrParts.map((p) =>
      p ? collapse(p.value) : "",
    ) as [string, string, string, string, string];
    let reason: string | null = null;
    if (!line1 || !city || !state || !postal) reason = "address_incomplete";
    else if (!/^[A-Za-z]{2}$/.test(state)) reason = "address_state_invalid";
    else if (!/^\d{5}(-?\d{4})?$/.test(postal)) reason = "address_postal_invalid";
    if (reason !== null) {
      for (const p of addrPaths) skip(p, reason);
    } else {
      const zip = postal.replace("-", "");
      address = {
        fieldPaths: addrPaths,
        value: {
          line1,
          line2: line2 || null,
          city,
          state: state.toUpperCase(),
          postalCode: zip.length === 9 ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip,
        },
      };
    }
  }

  return {
    ...(preferredName ? { preferredName } : {}),
    phones,
    ...(email ? { email } : {}),
    ...(address ? { address } : {}),
    skipped,
  };
}

// ── payload parse ───────────────────────────────────────────────────────────────────────────────────────

function fail(msg: string): never {
  throw new Error(`${M5_EXTRACTION_WRITEBACK_CONSUMER.consumerName}: ${msg}`);
}

export function parseCommitRequested(
  raw: unknown,
  organizationId: string,
): ExtractionCommitRequestedPayload {
  const p = raw as Partial<ExtractionCommitRequestedPayload> | null;
  if (
    !p ||
    typeof p.extractionCommitId !== "string" ||
    typeof p.organizationId !== "string" ||
    typeof p.targetAggregateId !== "string" ||
    p.targetModule !== "m5" ||
    !Array.isArray(p.fields) ||
    p.fields.some((f) => typeof f?.fieldPath !== "string" || typeof f?.value !== "string")
  ) {
    fail("malformed m22.extraction.commit_requested payload — refusing to guess");
  }
  if (p.organizationId !== organizationId) {
    fail(`payload org ${p.organizationId} != outbox row org ${organizationId}`);
  }
  return p as ExtractionCommitRequestedPayload;
}

// ── DB apply ────────────────────────────────────────────────────────────────────────────────────────────

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Apply one commit in ONE transaction; returns the reply it published. */
export async function applyExtractionWriteback(
  db: DbClient,
  outbox: M5OutboxPort,
  payload: ExtractionCommitRequestedPayload,
  now: () => Date = () => new Date(),
): Promise<DraftCreatedFromExtractionPayload> {
  const plan = planExtractionWriteback(payload.fields);
  const organizationId = payload.organizationId;
  const patientId = payload.targetAggregateId;

  return withOrgContext<DbClient, DraftCreatedFromExtractionPayload>(
    db,
    { organizationId, userId: "" },
    async (tx) => {
      const [patient] = await tx
        .select({
          status: P.status,
          providerEntityId: P.providerEntityId,
          locationId: P.locationId,
        })
        .from(P)
        .where(eq(P.id, patientId))
        .limit(1);
      if (!patient) fail(`patient '${patientId}' not found in this tenant`);
      if (patient.status === "merged") {
        fail(`patient '${patientId}' is merged — a writeback to a merged chart needs a human`);
      }
      const siting = {
        organizationId,
        patientId,
        providerEntityId: patient.providerEntityId,
        locationId: patient.locationId,
      };

      const outcomes: DocLensFieldOutcome[] = [...plan.skipped];
      const changed: string[] = [];
      const record = (paths: readonly string[], wrote: boolean, slot: string): void => {
        for (const fieldPath of paths) {
          outcomes.push({ fieldPath, outcome: wrote ? "applied" : "already_present" });
        }
        if (wrote && !changed.includes(slot)) changed.push(slot);
      };

      if (plan.preferredName) {
        const v = plan.preferredName.value;
        const [hit] = await tx
          .select({ id: ALIAS.id })
          .from(ALIAS)
          .where(
            and(eq(ALIAS.patientId, patientId), eq(ALIAS.kind, "preferred"), eq(ALIAS.fullName, v)),
          )
          .limit(1);
        if (!hit) await tx.insert(ALIAS).values({ ...siting, kind: "preferred", fullName: v });
        record([plan.preferredName.fieldPath], !hit, "preferredName");
      }

      for (const ph of plan.phones) {
        const [hit] = await tx
          .select({ id: PHONE.id })
          .from(PHONE)
          .where(
            and(eq(PHONE.patientId, patientId), eq(PHONE.kind, ph.kind), eq(PHONE.e164, ph.e164)),
          )
          .limit(1);
        if (!hit) {
          await tx
            .insert(PHONE)
            .values({ ...siting, kind: ph.kind, e164: ph.e164, isPrimary: false });
        }
        record([ph.fieldPath], !hit, ph.kind === "home" ? "phoneHome" : "phoneMobile");
      }

      if (plan.email) {
        const v = plan.email.value;
        const [hit] = await tx
          .select({ id: EMAIL.id })
          .from(EMAIL)
          .where(and(eq(EMAIL.patientId, patientId), sql`lower(${EMAIL.email}) = ${v}`))
          .limit(1);
        if (!hit) await tx.insert(EMAIL).values({ ...siting, email: v, isPrimary: false });
        record([plan.email.fieldPath], !hit, "email");
      }

      if (plan.address) {
        const a = plan.address.value;
        const [hit] = await tx
          .select({ id: ADDR.id })
          .from(ADDR)
          .where(
            and(
              eq(ADDR.patientId, patientId),
              isNull(ADDR.effectiveTo),
              eq(ADDR.line1, a.line1),
              a.line2 === null ? isNull(ADDR.line2) : eq(ADDR.line2, a.line2),
              eq(ADDR.city, a.city),
              eq(ADDR.state, a.state),
              eq(ADDR.postalCode, a.postalCode),
            ),
          )
          .limit(1);
        if (!hit) {
          // D5 append-only, never displacing the primary (the PatientMutator rule).
          await tx.insert(ADDR).values({
            ...siting,
            line1: a.line1,
            line2: a.line2,
            city: a.city,
            state: a.state,
            postalCode: a.postalCode,
            isPrimary: false,
            effectiveFrom: todayIso(),
          });
        }
        record(plan.address.fieldPaths, !hit, "address");
      }

      if (changed.length > 0) {
        await outbox.publish(tx, {
          eventName: "m5.patient.updated",
          payload: { patientId, organizationId, changed },
          organizationId,
          aggregateKind: "patient",
          aggregateId: patientId,
        });
      }

      const reply: DraftCreatedFromExtractionPayload = {
        patientId,
        organizationId,
        extractionCommitId: payload.extractionCommitId,
        fieldOutcomes: outcomes,
        appliedAt: now().toISOString(),
      };
      await outbox.publish(tx, {
        eventName: M5_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
        payload: reply as unknown as Record<string, unknown>,
        organizationId,
        aggregateKind: "patient",
        aggregateId: patientId,
      });
      return reply;
    },
  );
}

/** Build the live binding the composition root registers with the boot outbox dispatcher. */
export function buildM5ExtractionWritebackConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M5OutboxPort;
  readonly now?: () => Date;
}) {
  return {
    consumerName: M5_EXTRACTION_WRITEBACK_CONSUMER.consumerName,
    consumerModule: "m5" as const,
    eventTypes: [M5_EXTRACTION_WRITEBACK_CONSUMER.eventName] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const payload = parseCommitRequested(event.payload, event.organizationId);
      await applyExtractionWriteback(deps.db, deps.outbox, payload, deps.now);
    },
  };
}
