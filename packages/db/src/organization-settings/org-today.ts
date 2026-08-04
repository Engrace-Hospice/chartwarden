// @wardenx/db — todayForOrganization / organizationTimezone / serviceDateForOrganization
// (PARAM-004 follow-up). The one shared "what calendar date is this for this tenant" read,
// composing the org_timezone setting (settings-by-m1.ts) with the pure @wardenx/shared/dates
// helpers — so the backend call sites that used to slice a UTC instant (09-assessments, 37-ipu,
// 16-bereavement, 17-scheduling) share ONE implementation instead of N copies, the same
// convergence PARAM-004's frontend half already did for `ageYears`.
import { isValidTimeZone, localDateInTimeZone, orgLocalDateToday } from "@wardenx/shared/dates";
import { eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { organizations } from "../schema/organizations";
import { organizationSettingsReader } from "./reader";
import { DEFAULT_ORGANIZATION_TIMEZONE } from "./settings-by-m1";

/**
 * `organizationId`'s configured timezone (org_timezone, default `America/New_York`). Reads
 * `organization.settings` fresh — a caller that needs it for MULTIPLE date derivations in one
 * request (e.g. projecting a list of rows) should call this ONCE and reuse the string, not call
 * it per row. Fails closed to `DEFAULT_ORGANIZATION_TIMEZONE` if the organization row is missing
 * or its stored value is somehow not a real IANA zone (never silently falls back to naive UTC
 * slicing, which is the exact bug this function exists to let callers stop doing).
 */
export async function organizationTimezone(db: DbClient, organizationId: string): Promise<string> {
  const [row] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const timezone =
    organizationSettingsReader.get<string>(
      (row?.settings as Record<string, unknown> | undefined) ?? null,
      "org_timezone",
    ) ?? DEFAULT_ORGANIZATION_TIMEZONE;
  return isValidTimeZone(timezone) ? timezone : DEFAULT_ORGANIZATION_TIMEZONE;
}

/** Today's calendar date (`YYYY-MM-DD`) in `organizationId`'s configured timezone. */
export async function todayForOrganization(db: DbClient, organizationId: string): Promise<string> {
  return orgLocalDateToday(await organizationTimezone(db, organizationId));
}

/**
 * The calendar date (`YYYY-MM-DD`) a SPECIFIC instant (`instantIso`) falls on in
 * `organizationId`'s configured timezone — for deriving a stored `service_date`-shaped column
 * from a `scheduledStartedAt`-shaped instant, as distinct from "today" (`todayForOrganization`).
 */
export async function serviceDateForOrganization(
  db: DbClient,
  organizationId: string,
  instantIso: string,
): Promise<string> {
  const ms = Date.parse(instantIso);
  if (Number.isNaN(ms))
    throw new RangeError(`serviceDateForOrganization: malformed instant '${instantIso}'`);
  return localDateInTimeZone(new Date(ms), await organizationTimezone(db, organizationId));
}
