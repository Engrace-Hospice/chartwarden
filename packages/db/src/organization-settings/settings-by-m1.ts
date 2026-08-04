// @wardenx/db — M1's own organization-settings contributions (M1 Foundation §3.15.1).
//
// Same contribution pattern as settings-by-m3.ts / settings-by-m5.ts — the key belongs to M1
// itself here, since "what timezone does this org operate in" is a foundational, cross-cutting
// fact every module's "what day is it for this tenant" logic needs, not something owned by any
// one clinical module (PARAM-004 follow-up).
import { Type } from "@sinclair/typebox";
import type { ModuleSettingsContribution } from "./types";

// A reasonably strict IANA-shaped pattern (Area/City, optionally Area/Region/City, or the bare
// "UTC" zone) — NOT a full validation against the real IANA database (TypeBox has no such check).
// The actual authority is `Intl.DateTimeFormat`'s own validation at the point of use
// (packages/shared/src/dates/org-local-date.ts throws RangeError on a truly unknown zone, which
// callers fail closed on to the platform default) — this pattern only rejects obviously-wrong
// shapes early, at write time, with a clean validation error instead of a later runtime throw.
const IANA_TIMEZONE_PATTERN = "^(UTC|[A-Za-z_]+(/[A-Za-z_-]+){1,2})$";

/** The platform-floor default when a tenant has never set one — US Eastern, the single most common
 *  hospice-operating timezone; a tenant operating elsewhere sets its own via the settings API. */
export const DEFAULT_ORGANIZATION_TIMEZONE = "America/New_York";

export const M1_ORGANIZATION_SETTINGS: ModuleSettingsContribution = [
  {
    settingsKey: "org_timezone",
    registeredByModule: "m1",
    description:
      "The IANA timezone (e.g. 'America/Los_Angeles') this organization operates in — the " +
      "authority for every server-side 'what is today for this tenant' computation (service " +
      "dates, ABAC serviceDate matching, day-count/eligibility windows). Naively slicing a UTC " +
      "instant reads the wrong calendar day for a large fraction of every US business day " +
      "(4pm-midnight local time, UTC has already rolled to the next date) — this setting is what " +
      "lets that be computed correctly instead of assumed.",
    typeBoxSchema: Type.String({ pattern: IANA_TIMEZONE_PATTERN }),
    uniqueAcrossTenants: false,
    defaultValue: DEFAULT_ORGANIZATION_TIMEZONE,
    required: false,
  },
];
