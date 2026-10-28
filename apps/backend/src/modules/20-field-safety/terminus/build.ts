// apps/backend/src/modules/20-field-safety/terminus/build.ts - GAP-032: the boot-time binding of the terminus
// effect bag from environment + injected ports.
//
// DEGRADE, DO NOT REFUSE. A missing ops-page webhook must not stop the platform booting (refusing to start
// during an incident takes everything down). The terminus is still entered, the page row settles
// `skipped / pager_unbound`, and this function says so LOUDLY at boot. The same for a malformed URL.
// Nothing here logs a secret: only variable NAMES and on/off facts.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { MembershipId, SosContactCaller } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { createWebhookOpsPager } from "../jobs/terminus-port";
import { M20_WORKER_SYSTEM_USER_ID } from "../jobs/worker-support";
import type { SafetyDecipherPort } from "../routes/read-service-drizzle";
import { buildDrizzleSafetySeamStore } from "../seams/store-drizzle";
import type { SpokenNames, TerminusDeps } from "./deps";

type Env = Readonly<Record<string, string | undefined>>;

export const SOS_CONTACT_DIAL_ENABLED_VALUE = "enabled";
const GENERIC_AGENCY = "";
const GENERIC_SUBJECT = "";

/** The agency name (M2 `OrganizationReader` seam) and the clinician's display name (their user row). */
export function buildSpokenNamesReader(db: DbClient) {
  return async (organizationId: string, membershipId: MembershipId): Promise<SpokenNames> => {
    const [subject, orgs] = await Promise.all([
      withOrgContext(db, { organizationId, userId: M20_WORKER_SYSTEM_USER_ID }, async (handle) => {
        const [row] = await (handle as DbClient)
          .select({ name: schema.users.name })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(eq(schema.memberships.id, membershipId))
          .limit(1);
        return row?.name ?? GENERIC_SUBJECT;
      }),
      getSeam("OrganizationReader")
        .readByIds([organizationId])
        .catch(() => []),
    ]);
    const org = orgs[0];
    return {
      agencyName: org?.displayName || org?.legalName || GENERIC_AGENCY,
      subjectDisplayName: subject,
    };
  };
}

export interface BuildTerminusDepsInput {
  readonly env: Env;
  readonly db: DbClient;
  readonly caller: SosContactCaller;
  readonly decipher: SafetyDecipherPort;
  /** PHI-free boot sink. */
  readonly log: (line: string) => void;
}

export function buildM20TerminusDeps(input: BuildTerminusDepsInput): TerminusDeps {
  const { env, log } = input;

  let pager: TerminusDeps["pager"];
  const pagerUrl = env.CHARTWARDEN_OPS_PAGE_WEBHOOK_URL?.trim();
  if (pagerUrl) {
    try {
      pager = createWebhookOpsPager({
        url: pagerUrl,
        token: env.CHARTWARDEN_OPS_PAGE_WEBHOOK_TOKEN,
      });
    } catch {
      log(
        "[m20:terminus] CRITICAL: CHARTWARDEN_OPS_PAGE_WEBHOOK_URL is set but invalid (must be https://). " +
          "SOS emergency-terminus alerts will NOT page ChartWarden ops until it is fixed.",
      );
    }
  } else {
    log(
      "[m20:terminus] CRITICAL: CHARTWARDEN_OPS_PAGE_WEBHOOK_URL is not set. An SOS alert that reaches the emergency " +
        "terminus will be recorded but ChartWarden ops will NOT be paged (ledger: page_ops skipped / pager_unbound). " +
        "Set it to the on-call receiver.",
    );
  }

  const dialEnabled = env.CHARTWARDEN_SOS_CONTACT_DIAL === SOS_CONTACT_DIAL_ENABLED_VALUE;
  log(
    dialEnabled
      ? "[m20:terminus] emergency-contact auto-dial is ENABLED (CHARTWARDEN_SOS_CONTACT_DIAL=enabled)."
      : "[m20:terminus] emergency-contact auto-dial is OFF (set CHARTWARDEN_SOS_CONTACT_DIAL=enabled after the Twilio sandbox run and legal review).",
  );

  return {
    ...(pager ? { pager } : {}),
    caller: input.caller,
    dialEnabled,
    decipher: input.decipher,
    store: buildDrizzleSafetySeamStore(input.db),
    jurisdictions: () => getSeam("EmergencyServiceJurisdictionReader"),
    speakNames: buildSpokenNamesReader(input.db),
  };
}
