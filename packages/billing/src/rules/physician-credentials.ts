// @wardenx/billing — §4.5 rule `physician_credentials_active` (physician, error, regulatory). The
// attending NPI and the hospice physician NPI must be valid + active in NPPES (M40), and the required
// state license must be unexpired across the claim's service dates. Reads the resolved `mdm` snapshot;
// SKIPs when the M40 resolver is unbound. PURE: reads ctx only.
import type { PhysicianResolution, Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "physician_credentials_active";

function credentialDefect(label: string, p: PhysicianResolution | null): string | null {
  if (p === null) return `${label} physician is not identified`;
  if (p.status !== "active") return `${label} NPI ${p.npi} is ${p.status} in NPPES`;
  // Worded as "not confirmed unexpired" rather than "is expired" (F-126, #251): M40 tracks no per-state
  // license EXPIRY date for an external physician today, only the states held, so `false` here can mean
  // either a genuinely expired license or simply that expiry has never been confirmed — the message must
  // be true under both, and "is expired" would assert the former unconditionally.
  if (!p.licenseUnexpiredOnServiceDates)
    return `${label} state license is not confirmed unexpired across the claim's service dates`;
  return null;
}

export const physicianCredentialsActive: Rule = {
  key: KEY,
  version: 1,
  category: "physician",
  title: "Physician credentials active",
  description:
    "The attending NPI and the hospice physician NPI must be valid + active in NPPES (M40) and hold an " +
    "unexpired state license across the claim's service dates.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    if (!ctx.seams.mdmResolverBound) {
      return skip(
        KEY,
        "error",
        "seam_not_bound",
        "MDM/NPPES resolver (M40) not bound — credential check deferred.",
      );
    }
    const defects: string[] = [];
    // The hospice physician is always required; the attending is required when one is on file.
    const hospiceDefect = credentialDefect("hospice", ctx.mdm.hospicePhysician);
    if (hospiceDefect !== null) defects.push(hospiceDefect);
    if (ctx.mdm.attending !== null) {
      const attendingDefect = credentialDefect("attending", ctx.mdm.attending);
      if (attendingDefect !== null) defects.push(attendingDefect);
    }
    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        "Attending and hospice physician credentials are active and licensed.",
      );
    }
    return fail(
      KEY,
      "error",
      `Physician credential defects: ${defects.length}.`,
      {
        summary: "Correct the physician record / re-verify NPPES + state license (M40).",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "verify_in_m40",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "" },
    );
  },
};
