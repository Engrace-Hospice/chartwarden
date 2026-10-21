// apps/backend/src/modules/16-bereavement/seams/bereavement-census-for-org.ts — GAP-080.
//
// The org-explicit, aggregate-only bereavement census M27's Worksheet S-3 bereavement statistics need: how many
// bereaved contacts the agency served in the fiscal window and how many bereavement VISITS (counselor touchpoints that
// actually took place) it delivered. `bereaved_contact` / `bereavement_outreach` are M16's tables, so the read lives here
// and M27 receives it as a locally-declared PORT at the composition root. Counts only — no contact, plan or patient id.
//
//   contactsCount — distinct bereaved contacts of plans sited at the provider entity that were not merely proposed or
//                   ineligible, and whose plan was opened on or before the window's end (the bereavement program runs
//                   13 months, so a plan opened before the window still serves its contacts inside it).
//   visitsCount   — COMPLETED outreach touchpoints (phone call, in-person visit, group invitation, …) with
//                   `completed_at` inside the window. Mailed cards / letters / email are contact, not visits, and are
//                   reported separately as `mailedContactsCount` (the S-3 form counts visits and contacts apart).
//
// Not a request: opens its own `withOrgContext` envelope (empty acting user) with explicit `organization_id` predicates
// behind RLS.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, inArray, isNotNull, lt, lte, notInArray, sql } from "drizzle-orm";

const CONTACT = schema.bereavedContact;
const PLAN = schema.bereavementPlan;
const OUTREACH = schema.bereavementOutreach;

const SEAM_READER_SYSTEM_USER_ID = "";

/** Touchpoint kinds that are a person-to-person VISIT/contact (vs a mailed artifact). */
export const BEREAVEMENT_VISIT_KINDS = [
  "phone_call",
  "in_person_visit",
  "group_support_invitation",
  "portal_message",
] as const;
export const BEREAVEMENT_MAILED_KINDS = [
  "sympathy_card",
  "sympathy_letter",
  "anniversary_letter",
  "email",
] as const;

export interface BereavementCensus {
  readonly contactsCount: number;
  readonly visitsCount: number;
  readonly mailedContactsCount: number;
}

export function bereavementCensusForOrg(
  db: DbClient,
  organizationId: string,
  window: { readonly providerEntityId: string; readonly from: string; readonly to: string },
): Promise<BereavementCensus> {
  const fromTs = new Date(`${window.from}T00:00:00.000Z`);
  const toTsExclusive = new Date(new Date(`${window.to}T00:00:00.000Z`).getTime() + 86_400_000);
  return withOrgContext(
    db,
    { organizationId, userId: SEAM_READER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as DbClient;
      const [contacts] = await tx
        .select({ n: sql<number>`count(distinct ${CONTACT.id})::int` })
        .from(CONTACT)
        .innerJoin(PLAN, eq(PLAN.id, CONTACT.planId))
        .where(
          and(
            eq(CONTACT.organizationId, organizationId),
            eq(PLAN.providerEntityId, window.providerEntityId),
            notInArray(CONTACT.status, ["proposed", "ineligible_post_review"]),
            isNotNull(PLAN.openedAt),
            lt(PLAN.openedAt, toTsExclusive),
          ),
        );
      const outreachCount = async (kinds: readonly string[]): Promise<number> => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(OUTREACH)
          .where(
            and(
              eq(OUTREACH.organizationId, organizationId),
              eq(OUTREACH.providerEntityId, window.providerEntityId),
              eq(OUTREACH.status, "completed"),
              inArray(OUTREACH.kind, kinds as never),
              gte(OUTREACH.completedAt, fromTs),
              lte(OUTREACH.completedAt, new Date(toTsExclusive.getTime() - 1)),
            ),
          );
        return row?.n ?? 0;
      };
      return {
        contactsCount: contacts?.n ?? 0,
        visitsCount: await outreachCount(BEREAVEMENT_VISIT_KINDS),
        mailedContactsCount: await outreachCount(BEREAVEMENT_MAILED_KINDS),
      };
    },
  );
}
