// apps/backend/src/modules/34-saas-tenant-platform/onboarding/org-profile.ts — the org profile the wizard edits.
//
// The organisation's display name and time zone (`organization.display_name`, `organization.settings.org_timezone`) belong
// to M1/M2. M34 reaches them through this port (the composition root binds `bootstrap/org-profile.ts`, the
// `org-spine-facts.ts` precedent), never through the table. The validators here are the authority on what is accepted.
import { organizationSettingsReader } from "@chartwarden/db";
import { isValidTimeZone } from "@chartwarden/shared/dates";
import { ChartWardenError } from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";

export const DISPLAY_NAME_MAX = 200;

export interface OrgProfile {
  readonly displayName: string;
  /** The IANA zone every "what day is it for this tenant" computation uses. */
  readonly orgTimezone: string;
}

export interface OrgProfilePatch {
  readonly displayName?: string;
  readonly orgTimezone?: string;
}

export interface OrgProfilePort {
  read(organizationId: string): Promise<OrgProfile | null>;
  /** Writes the validated patch under the org's own RLS context and returns the stored profile. */
  update(organizationId: string, patch: OrgProfilePatch, actorUserId: string): Promise<OrgProfile>;
}

const refuse = (field: string, code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 422, [{ field, code, message }]);

/** A valid IANA zone: the registered org_timezone shape AND a zone `Intl` actually knows (e.g. not "Mars/Olympus"). */
export function validateOrgTimezone(value: unknown): string {
  const tz = typeof value === "string" ? value.trim() : "";
  const entry = organizationSettingsReader.entry("org_timezone");
  if (!entry || !Value.Check(entry.typeBoxSchema, tz) || !isValidTimeZone(tz)) {
    throw refuse(
      "orgTimezone",
      "INVALID_ORG_TIMEZONE",
      "orgTimezone must be a valid IANA time zone, for example America/Chicago",
    );
  }
  return tz;
}

export function validateDisplayName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > DISPLAY_NAME_MAX) {
    throw refuse(
      "displayName",
      "INVALID_DISPLAY_NAME",
      `displayName must be 1 to ${DISPLAY_NAME_MAX} characters`,
    );
  }
  return name;
}

/** At least one field, each validated; returns the normalized patch. */
export function normalizeOrgProfilePatch(input: {
  readonly displayName?: unknown;
  readonly orgTimezone?: unknown;
}): OrgProfilePatch {
  if (input.displayName === undefined && input.orgTimezone === undefined) {
    throw refuse("displayName", "ORG_PROFILE_EMPTY", "send displayName, orgTimezone or both");
  }
  return {
    ...(input.displayName !== undefined
      ? { displayName: validateDisplayName(input.displayName) }
      : {}),
    ...(input.orgTimezone !== undefined
      ? { orgTimezone: validateOrgTimezone(input.orgTimezone) }
      : {}),
  };
}
