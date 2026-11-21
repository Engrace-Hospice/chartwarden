// @chartwarden/medicaid-adapters — §4.6 Room & Board rules (42 CFR §418.302/.310/.318). PURE: read ctx only.
import { fail, pass, skip } from "./types";
import type { MedicaidRule } from "./types";

/** Non-overridable gate: a revalidation worker without current M24/M6 reads cannot restore R&B claims to READY. */
export const medicaidRbClaimSnapshotVerified: MedicaidRule = {
  key: "medicaid_rb_claim_snapshot_verified",
  version: 1,
  category: "rb",
  title: "R&B claim snapshot is verified",
  description:
    "A claim containing Room & Board lines must be checked against its billed-day ownership, arrangement and current M6 LOC snapshot before it can become ready.",
  severity: "error",
  regulatoryRequired: false,
  platformRequired: true,
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_rb_claim_snapshot_verified";
    const includesRoomAndBoard =
      ctx.claim.kind !== "hospice_only" || ctx.lines.some((line) => line.isRb);
    if (!includesRoomAndBoard || ctx.rbClaimSnapshotVerified) {
      return pass(KEY, "error", "The R&B claim snapshot is either not applicable or was verified.");
    }
    return fail(
      KEY,
      "error",
      "Current Room & Board day ownership, arrangement and M6 level-of-care evidence were not verified for this validation run.",
      {
        summary:
          "Run the authorized claim validation to recheck Room & Board facts before the claim can become ready.",
        fixAction: "revalidate_rb_claim_snapshot",
      },
    );
  },
};

/** A manual or worker validation must recheck stored hospice lines against current M6 LOC facts before READY. */
export const medicaidHospiceClaimSnapshotVerified: MedicaidRule = {
  key: "medicaid_hospice_claim_snapshot_verified",
  version: 1,
  category: "documentation",
  title: "Hospice claim lines match current M6 periods",
  description:
    "Hospice claim lines must cover the service range and match the current M6 level-of-care periods, revenue codes and saved line arithmetic.",
  severity: "error",
  regulatoryRequired: false,
  platformRequired: true,
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_hospice_claim_snapshot_verified";
    if (ctx.claim.kind === "rb_only" || ctx.hospiceClaimSnapshotVerified) {
      return pass(
        KEY,
        "error",
        "Hospice lines are either not applicable or match current M6 periods.",
      );
    }
    return fail(
      KEY,
      "error",
      "Current M6 level-of-care periods were not verified against the stored hospice claim lines.",
      {
        summary:
          "Run authorized claim validation to compare the stored hospice lines with the current M6 stay before marking the claim ready.",
        fixAction: "revalidate_hospice_claim_snapshot",
      },
    );
  },
};

/**
 * medicaid_rb_arrangement_required_for_nf_resident — if the patient is NF/SNF-resident on any service date
 * in the claim range, an rb_arrangement must be set; conversely an R&B line requires an arrangement.
 */
export const medicaidRbArrangementRequiredForNfResident: MedicaidRule = {
  key: "medicaid_rb_arrangement_required_for_nf_resident",
  version: 1,
  category: "rb",
  title: "R&B arrangement required for NF resident",
  description:
    "An NF/SNF-resident patient's claim must carry an rb_arrangement; an R&B line cannot exist without one.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_rb_arrangement_required_for_nf_resident";
    if (!ctx.seams.rbBound) {
      return skip(KEY, "error", "seam_not_bound", "R&B seam unbound; rule deferred.");
    }
    const nfDays = ctx.nfResidentDays.filter((d) => d.isNfResident);
    const hasRbLine = ctx.lines.some((l) => l.isRb);
    if ((nfDays.length > 0 || hasRbLine) && ctx.claim.rbArrangementId === null) {
      return fail(
        KEY,
        "error",
        hasRbLine
          ? "Claim has an R&B line but no rb_arrangement."
          : `Patient is NF-resident on ${nfDays.length} service date(s) but the claim has no rb_arrangement.`,
        {
          summary: "Create and activate the R&B arrangement for the NF/SNF stay before billing.",
          fixAction: "create_rb_arrangement",
        },
        { nfResidentDays: nfDays.length },
      );
    }
    return pass(KEY, "error", "R&B arrangement requirement satisfied.");
  },
};

/**
 * medicaid_rb_day_loc_coherence — every billable/billed R&B day's hospice LOC-of-day is routine (RHC) or
 * CHC in the NF; no R&B day on a GIP day (hospice IPU is place-of-service) or respite-elsewhere (IRC) day.
 */
export const medicaidRbDayLocCoherence: MedicaidRule = {
  key: "medicaid_rb_day_loc_coherence",
  version: 1,
  category: "rb",
  title: "R&B day LOC coherence",
  description:
    "Billable/billed R&B days must fall on a routine (RHC) or CHC hospice day in the NF — never on a GIP " +
    "or respite (IRC) day.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_rb_day_loc_coherence";
    if (!ctx.seams.rbBound) {
      return skip(KEY, "error", "seam_not_bound", "R&B seam unbound; rule deferred.");
    }
    const offending = ctx.rbDays.filter(
      (d) =>
        (d.status === "billable" || d.status === "billed") &&
        (d.locOfDay === "GIP" || d.locOfDay === "IRC"),
    );
    if (offending.length === 0) {
      return pass(KEY, "error", "All R&B days fall on routine/CHC hospice days.");
    }
    return fail(
      KEY,
      "error",
      `${offending.length} R&B day(s) fall on a GIP or respite (IRC) day.`,
      { summary: "Exclude R&B for GIP / respite-elsewhere days.", fixAction: "exclude_rb_day" },
      { offendingDays: offending.length },
    );
  },
};

/**
 * medicaid_rb_contract_effective_for_service_date — the rb_arrangement is ACTIVE and effective on every
 * R&B day in the claim.
 */
export const medicaidRbContractEffectiveForServiceDate: MedicaidRule = {
  key: "medicaid_rb_contract_effective_for_service_date",
  version: 1,
  category: "rb",
  title: "R&B contract effective for service date",
  description:
    "Every R&B day in the claim falls within the rb_arrangement's ACTIVE effective window.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_rb_contract_effective_for_service_date";
    if (!ctx.seams.rbBound) {
      return skip(KEY, "error", "seam_not_bound", "R&B seam unbound; rule deferred.");
    }
    const billables = ctx.rbDays.filter((d) => d.status === "billable" || d.status === "billed");
    const uncovered = billables.filter((d) => !d.arrangementEffectiveOnDate);
    if (uncovered.length === 0) {
      return pass(KEY, "error", "All R&B days are within an effective arrangement window.");
    }
    return fail(
      KEY,
      "error",
      `${uncovered.length} R&B day(s) fall outside the arrangement's effective window.`,
      {
        summary: "Adjust the arrangement effective dates or exclude the uncovered R&B day(s).",
        fixAction: "edit_rb_arrangement",
      },
      { uncoveredDays: uncovered.length },
    );
  },
};
