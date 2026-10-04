// apps/web/src/modules/05-patient — shared vocabulary for the Privacy Officer screens (M5 §5.1 "Privacy
// flags", §4.2 resync). Labels only: the SERVER decides every restriction, origin and permission.
import type { StatusTone } from "@wardenx/ui";

export type PrivacyFlagOrigin =
  | "consent"
  | "intake_unconfirmed"
  | "intake_confirmed"
  | "unattributed";

export const PRIVACY_FLAG_LABEL: Record<string, string> = {
  sud: "Substance use (42 CFR Part 2)",
  hiv: "HIV / AIDS",
  mental_health: "Mental health",
  genetic: "Genetic",
  minor_restricted: "Minor — restricted",
  abuse_victim: "Abuse victim",
};
export const privacyFlagLabel = (f: string): string => PRIVACY_FLAG_LABEL[f] ?? f;

export const ORIGIN_LABEL: Record<PrivacyFlagOrigin, string> = {
  consent: "Consent state — no Part 2 release in force",
  intake_unconfirmed: "WardenLens detection — unreviewed",
  intake_confirmed: "WardenLens detection — confirmed by reviewer",
  unattributed: "Source not recorded",
};

export const ORIGIN_TONE: Record<PrivacyFlagOrigin, StatusTone> = {
  consent: "warning",
  intake_unconfirmed: "critical",
  intake_confirmed: "warning",
  unattributed: "neutral",
};

/** Who may clear a restriction of this origin, and how (M22 §7.4 W4 step 6; M5 D3/D10). */
export const ORIGIN_CLEARANCE: Record<PrivacyFlagOrigin, string> = {
  intake_unconfirmed:
    "Only a licensed reviewer (RN or above, with intake review access) can confirm or reject this detection, in the intake review. Rejecting it as a false positive retires the flag unless another packet still holds it; discarding an unreviewed packet withdraws its detection.",
  intake_confirmed:
    "A reviewer confirmed Part 2 content. The restriction stays until a 42 CFR Part 2 (§2.31) release is recorded in the patient's consents.",
  consent:
    "Lifted only when a 42 CFR Part 2 (§2.31) release is signed and active in the patient's consents.",
  unattributed:
    "No source recorded. Re-sync re-reads consent state; categories other than substance use are not driven by consents yet.",
};

export type PrivacyDrift =
  | "snapshot_stale"
  | "consent_active_but_restricted"
  | "consent_inactive_but_unrestricted"
  | "intake_detection_without_flag"
  | "intake_confirmed_not_promoted"
  | "intake_flag_without_detection";

export const DRIFT_TEXT: Record<PrivacyDrift, string> = {
  snapshot_stale:
    "The restriction snapshot is marked stale. Re-sync to rebuild it from consent state.",
  consent_active_but_restricted:
    "A Part 2 release is in force, but the snapshot still restricts substance-use records. Re-sync to apply the consent.",
  consent_inactive_but_unrestricted:
    "No Part 2 release is in force, but the snapshot does not restrict substance-use records. Re-sync to restore the restriction.",
  intake_detection_without_flag:
    "A WardenLens detection is pending or confirmed, but the snapshot carries no substance-use flag. Re-sync to re-apply it.",
  intake_confirmed_not_promoted:
    "A reviewer confirmed the detection, but the flag still reads unreviewed. Re-sync to record the confirmation.",
  intake_flag_without_detection:
    "The flag is attributed to WardenLens, but no packet still holds a detection. Re-sync does not lift it; check the intake review history.",
};

export const SUD_STATUS_PILL: Record<
  "detected" | "confirmed" | "rejected",
  { label: string; tone: StatusTone }
> = {
  detected: { label: "Unreviewed", tone: "critical" },
  confirmed: { label: "Confirmed", tone: "warning" },
  rejected: { label: "Rejected (false positive)", tone: "neutral" },
};

export const usDateTime = (v: string | null | undefined): string => {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};
