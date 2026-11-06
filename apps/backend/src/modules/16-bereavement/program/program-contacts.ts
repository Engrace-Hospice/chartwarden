// apps/backend/src/modules/16-bereavement/program/program-contacts.ts — ADR-0109 D10 (PR 3): who is a PROGRAM FAMILY right now.
//
// Support groups and memorial services are for program families only (owner, 2026-11-05). A contact qualifies while it is `active`, its plan is
// `active`, and it has no OPEN opt-out of kind `full` or `pause_temporarily` (a `no_mailings` or channel opt-out stops letters, not a group or a
// memorial). One set-based read per call: the contacts joined to their plan, then their open opt-out rows. No decryption.
import { type DbClient, schema } from "@chartwarden/db";
import type { BereavedContactRelationship } from "@chartwarden/types";
import { and, eq, inArray, isNull } from "drizzle-orm";

export interface ProgramContactFacts {
  readonly contactId: string;
  readonly planId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly displayName: string;
  readonly relationshipCode: BereavedContactRelationship;
  readonly portalAccountId: string | null;
  /** True while the contact is a program family member (see the module header). */
  readonly inProgram: boolean;
}

/** The opt-out kinds that take a contact out of groups and memorials (the others narrow mailings or a channel only). */
export const PROGRAM_BLOCKING_OPT_OUT_KINDS = ["full", "pause_temporarily"] as const;

/** Pure: the program-family rule over already-loaded facts. */
export function isProgramFamily(facts: {
  readonly contactStatus: string;
  readonly planStatus: string;
  readonly openOptOutKinds: readonly string[];
}): boolean {
  return (
    facts.contactStatus === "active" &&
    facts.planStatus === "active" &&
    !facts.openOptOutKinds.some((k) =>
      (PROGRAM_BLOCKING_OPT_OUT_KINDS as readonly string[]).includes(k),
    )
  );
}

const ID_CHUNK = 1000;

/** Load the program facts of the named contacts (absent / other-tenant ids are simply missing from the map). */
export async function loadProgramContacts(
  tx: DbClient,
  contactIds: readonly string[],
): Promise<Map<string, ProgramContactFacts>> {
  const C = schema.bereavedContact;
  const P = schema.bereavementPlan;
  const O = schema.bereavementOptOut;
  const out = new Map<string, ProgramContactFacts>();
  const unique = [...new Set(contactIds)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    const rows = await tx
      .select({
        contactId: C.id,
        planId: C.planId,
        providerEntityId: C.providerEntityId,
        locationId: C.locationId,
        displayName: C.displayName,
        relationshipCode: C.relationshipCode,
        portalAccountId: C.portalAccountId,
        contactStatus: C.status,
        planStatus: P.status,
      })
      .from(C)
      .innerJoin(P, eq(P.id, C.planId))
      .where(inArray(C.id, chunk));
    if (rows.length === 0) continue;
    const opts = await tx
      .select({ contactId: O.bereavedContactId, kind: O.optOutKind })
      .from(O)
      .where(and(inArray(O.bereavedContactId, chunk), isNull(O.rescindedAt)));
    const kindsBy = new Map<string, string[]>();
    for (const o of opts) kindsBy.set(o.contactId, [...(kindsBy.get(o.contactId) ?? []), o.kind]);
    for (const r of rows) {
      out.set(r.contactId, {
        contactId: r.contactId,
        planId: r.planId,
        providerEntityId: r.providerEntityId,
        locationId: r.locationId ?? null,
        displayName: r.displayName,
        relationshipCode: r.relationshipCode as BereavedContactRelationship,
        portalAccountId: r.portalAccountId ?? null,
        inProgram: isProgramFamily({
          contactStatus: r.contactStatus,
          planStatus: r.planStatus,
          openOptOutKinds: kindsBy.get(r.contactId) ?? [],
        }),
      });
    }
  }
  return out;
}

/** The SQL predicate "this contact (alias `c`, plan alias `p`) is a program family right now", for set-based reads and sweeps. */
export const PROGRAM_FAMILY_SQL = `c.status = 'active' AND p.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM bereavement_opt_out o
   WHERE o.bereaved_contact_id = c.id AND o.rescinded_at IS NULL AND o.opt_out_kind IN ('full', 'pause_temporarily'))`;
