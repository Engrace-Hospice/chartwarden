// apps/backend/src/modules/16-bereavement/mailings/facts-drizzle.ts — ADR-0109 D10: load the facts `decideMailingEligibility` decides over, SET-BASED.
//
// One query for the contacts (joined to their plan), one for their OPEN opt-out rows; no per-contact round trip and NO decryption: whether an address
// is stored is `*_cipher IS NOT NULL`. The same pure rule runs at `generate` (every contact of every ACTIVE plan: selects the batch) and, through
// `ineligibleIncludedItems`, over the run's `included` items whatever their plan's status is NOW: in the render worker just before rendering, at
// `download` (a stale batch is refused) and at `confirm-mailed` (bookkeeping: whoever dropped out is not logged as mailed).
import { type DbClient, schema } from "@chartwarden/db";
import type {
  BereavedContactRelationship,
  BereavementMailingExclusionReason,
  BereavementMailingKey,
  BereavementOptOutKind,
  BereavementOutreachKind,
} from "@chartwarden/types";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type MailingEligibilityFacts,
  type OpenOptOutFact,
  decideMailingEligibility,
} from "./eligibility";

type Tx = DbClient;

/** Rows per `IN (...)` list when loading a named set of contacts. */
const CONTACT_ID_CHUNK = 1000;

/** The per-run knobs that are not stored on the contact. */
export interface MailingFactsContext {
  /** The run's audience filter (config `audience_relationships`); null = every relationship. */
  readonly audience: readonly BereavedContactRelationship[] | null;
  /** Is an email channel bound for this tenant? (False today.) */
  readonly emailChannelAvailable: boolean;
}

export interface MailingCandidate {
  readonly contactId: string;
  readonly planId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly facts: MailingEligibilityFacts;
}

export type MailingCandidateScope =
  /** Every contact of every ACTIVE plan (selecting a batch). */
  | { readonly kind: "active_plans" }
  /** Exactly these contacts, whatever state their plan is in now (re-checking a rendered batch). */
  | { readonly kind: "contacts"; readonly contactIds: readonly string[] };

const allowedKindsOf = (raw: unknown): readonly BereavementOutreachKind[] | undefined => {
  const kinds = (raw as { allowed_kinds?: unknown } | null)?.allowed_kinds;
  const list = Array.isArray(kinds)
    ? kinds.filter((k): k is BereavementOutreachKind => typeof k === "string")
    : [];
  return list.length > 0 ? list : undefined;
};

const channelKindsOf = (raw: unknown): readonly string[] | null =>
  Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : null;

export async function loadMailingCandidates(
  tx: Tx,
  scope: MailingCandidateScope,
  ctx: MailingFactsContext,
): Promise<MailingCandidate[]> {
  const C = schema.bereavedContact;
  const P = schema.bereavementPlan;
  const O = schema.bereavementOptOut;

  const chunks =
    scope.kind === "active_plans"
      ? [null]
      : Array.from({ length: Math.ceil(scope.contactIds.length / CONTACT_ID_CHUNK) }, (_, i) =>
          scope.contactIds.slice(i * CONTACT_ID_CHUNK, (i + 1) * CONTACT_ID_CHUNK),
        );

  const out: MailingCandidate[] = [];
  for (const chunk of chunks) {
    const contactFilter =
      chunk === null ? eq(P.status, "active") : inArray(C.id, chunk as string[]);
    const contacts = await tx
      .select({
        contactId: C.id,
        planId: C.planId,
        providerEntityId: C.providerEntityId,
        locationId: C.locationId,
        status: C.status,
        relationship: C.relationshipCode,
        prefs: C.outreachPreferencesJsonb,
        hasEmail: sql<boolean>`${C.emailCipher} is not null`,
        hasAddress: sql<boolean>`${C.mailingAddressCipher} is not null`,
        planStatus: P.status,
      })
      .from(C)
      .innerJoin(P, eq(P.id, C.planId))
      .where(contactFilter)
      .orderBy(asc(C.createdAt), asc(C.id));
    if (contacts.length === 0) continue;

    const optRows = await tx
      .select({
        contactId: O.bereavedContactId,
        kind: O.optOutKind,
        channelKinds: O.channelKinds,
      })
      .from(O)
      .innerJoin(P, eq(P.id, O.planId))
      .innerJoin(C, eq(C.id, O.bereavedContactId))
      .where(and(isNull(O.rescindedAt), contactFilter));
    const optOutsByContact = new Map<string, OpenOptOutFact[]>();
    for (const row of optRows) {
      const list = optOutsByContact.get(row.contactId) ?? [];
      list.push({
        optOutKind: row.kind as BereavementOptOutKind,
        channelKinds: channelKindsOf(row.channelKinds),
      });
      optOutsByContact.set(row.contactId, list);
    }

    for (const c of contacts) {
      out.push({
        contactId: c.contactId,
        planId: c.planId,
        providerEntityId: c.providerEntityId,
        locationId: c.locationId ?? null,
        facts: {
          planStatus: c.planStatus,
          contactStatus: c.status,
          relationship: c.relationship as BereavedContactRelationship,
          openOptOuts: optOutsByContact.get(c.contactId) ?? [],
          allowedKinds: allowedKindsOf(c.prefs),
          hasMailingAddress: c.hasAddress,
          hasEmailAddress: c.hasEmail,
          audience: ctx.audience,
          emailChannelAvailable: ctx.emailChannelAvailable,
        },
      });
    }
  }
  return out;
}

/** The run's audience filter: the CURRENT config's (a memorial run has no mailing key and so no audience). */
export async function mailingFactsContextOf(
  tx: Tx,
  mailingKey: BereavementMailingKey | null,
  emailChannelAvailable: boolean,
): Promise<MailingFactsContext> {
  if (mailingKey === null) return { audience: null, emailChannelAvailable };
  const CONFIG = schema.bereavementMailingConfig;
  const [cfg] = await tx
    .select({ audience: CONFIG.audienceRelationships })
    .from(CONFIG)
    .where(eq(CONFIG.mailingKey, mailingKey))
    .limit(1);
  return {
    audience: (cfg?.audience ?? null) as BereavedContactRelationship[] | null,
    emailChannelAvailable,
  };
}

/**
 * Re-decide the run's `included` items against TODAY's facts with the rule that selected them. Returns the item ids that are no longer eligible, with
 * the reason (a contact that no longer exists reads as `contact_not_engageable`). Empty map = the batch still stands.
 */
export async function ineligibleIncludedItems(
  tx: Tx,
  run: { readonly id: string; readonly mailingKey: BereavementMailingKey | null },
  emailChannelAvailable: boolean,
): Promise<Map<string, BereavementMailingExclusionReason>> {
  const ITEM = schema.bereavementMailingItem;
  const included = await tx
    .select({ id: ITEM.id, contactId: ITEM.bereavedContactId })
    .from(ITEM)
    .where(and(eq(ITEM.runId, run.id), eq(ITEM.status, "included")));
  const out = new Map<string, BereavementMailingExclusionReason>();
  if (included.length === 0) return out;
  const candidates = await loadMailingCandidates(
    tx,
    { kind: "contacts", contactIds: included.map((i) => i.contactId) },
    await mailingFactsContextOf(tx, run.mailingKey, emailChannelAvailable),
  );
  const decided = new Map(
    candidates.map((c) => [c.contactId, decideMailingEligibility(c.facts)] as const),
  );
  for (const item of included) {
    const decision = decided.get(item.contactId);
    if (decision === undefined) out.set(item.id, "contact_not_engageable");
    else if (!decision.eligible) out.set(item.id, decision.reason);
  }
  return out;
}

/** Rows per `IN (...)` list when flagging items. */
const ITEM_FLAG_CHUNK = 500;

/**
 * Move still-`included` items out of the batch with their reason, chunked per reason. `excluded` before a render (the worker), `excluded_after_render`
 * once the batch left the system (confirm-mailed: the ordinal is KEPT, it is the "Ref N" printed on the letter staff pull). Returns how many rows moved.
 */
export async function flagItems(
  tx: Tx,
  reasons: ReadonlyMap<string, BereavementMailingExclusionReason>,
  status: "excluded" | "excluded_after_render",
): Promise<number> {
  const ITEM = schema.bereavementMailingItem;
  const byReason = new Map<BereavementMailingExclusionReason, string[]>();
  for (const [id, reason] of reasons) byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
  let moved = 0;
  for (const [reason, ids] of byReason) {
    for (let i = 0; i < ids.length; i += ITEM_FLAG_CHUNK) {
      const rows = await tx
        .update(ITEM)
        .set({
          status,
          exclusionReason: reason,
          ...(status === "excluded" ? { ordinal: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(inArray(ITEM.id, ids.slice(i, i + ITEM_FLAG_CHUNK)), eq(ITEM.status, "included")),
        )
        .returning({ id: ITEM.id });
      moved += rows.length;
    }
  }
  return moved;
}
