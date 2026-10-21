// apps/backend/src/modules/29-external-interfaces/inbound — OBX-8 abnormal-flag classification (M29-T05, D7).
// PURE, no IO. Two jobs:
//   1. Normalize a raw OBX-8 token into the `lab_abnormal_flag` enum (H/L/HH/LL/A/N) the value column stores.
//   2. Roll the per-value flags up into the observation-level `lab_abnormal_summary` (any_critical /
//      any_abnormal / all_normal / no_flags) AND decide whether the message trips the D7 critical-RN-alert
//      path — ONLY the HH/LL "critical" flags page a caseload RN; the single-letter H/L/A "abnormal" flags
//      surface in the dashboard without an active alert (T-29.07 §8, folded into the M29 spec's D7 note).
//
// The `lab_abnormal_flag` enum has no `AA`; a raw `AA`/`>`/`<`/unknown token is NOT coerced into a wrong
// enum member — it maps to `null` (the column is nullable) and is treated as non-critical, so a bad flag can
// never silently forge a critical page. The lab is authoritative for the flag it sends; we surface exactly
// the six values HL7 Table 0078's hospice subset defines.
import type { LabAbnormalFlag, LabAbnormalSummary } from "@chartwarden/types";
import { LAB_ABNORMAL_FLAGS } from "@chartwarden/types";

const ABNORMAL_FLAG_SET: ReadonlySet<string> = new Set<string>(LAB_ABNORMAL_FLAGS);
/** The two flags that page a caseload RN (D7). */
const CRITICAL_FLAGS: ReadonlySet<LabAbnormalFlag> = new Set<LabAbnormalFlag>(["HH", "LL"]);
/** The flags that surface as "abnormal" (dashboard, no page). */
const ABNORMAL_FLAGS: ReadonlySet<LabAbnormalFlag> = new Set<LabAbnormalFlag>(["H", "L", "A"]);

/** Coerce a raw OBX-8 token to the `lab_abnormal_flag` enum, or `null` when it is not a recognized member. */
export function mapAbnormalFlag(raw: string | undefined): LabAbnormalFlag | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  return ABNORMAL_FLAG_SET.has(upper) ? (upper as LabAbnormalFlag) : null;
}

/** The single most-severe recognized flag across a set of raw OBX-8 tokens (critical > abnormal > normal). */
export function selectValueFlag(rawFlags: readonly string[]): LabAbnormalFlag | null {
  const mapped = rawFlags.map(mapAbnormalFlag).filter((f): f is LabAbnormalFlag => f !== null);
  if (mapped.length === 0) return null;
  const critical = mapped.find((f) => CRITICAL_FLAGS.has(f));
  if (critical) return critical;
  const abnormal = mapped.find((f) => ABNORMAL_FLAGS.has(f));
  if (abnormal) return abnormal;
  return mapped.find((f) => f === "N") ?? mapped[0]!;
}

/** True when a token set carries a critical (HH/LL) flag — the D7 caseload-RN alert trigger. */
export function isCriticalFlagSet(rawFlags: readonly string[]): boolean {
  return rawFlags.some((f) => {
    const mapped = mapAbnormalFlag(f);
    return mapped !== null && CRITICAL_FLAGS.has(mapped);
  });
}

/**
 * Roll the per-value flags up into the observation-level `lab_abnormal_summary`:
 *   any_critical — at least one HH/LL,
 *   any_abnormal — at least one H/L/A (and no critical),
 *   all_normal   — at least one explicit N (and nothing abnormal),
 *   no_flags     — every value's flag column is null (no flag reported).
 */
export function computeAbnormalSummary(
  valueFlags: readonly (LabAbnormalFlag | null)[],
): LabAbnormalSummary {
  let anyCritical = false;
  let anyAbnormal = false;
  let anyNormal = false;
  for (const flag of valueFlags) {
    if (flag === null) continue;
    if (CRITICAL_FLAGS.has(flag)) anyCritical = true;
    else if (ABNORMAL_FLAGS.has(flag)) anyAbnormal = true;
    else if (flag === "N") anyNormal = true;
  }
  if (anyCritical) return "any_critical";
  if (anyAbnormal) return "any_abnormal";
  if (anyNormal) return "all_normal";
  return "no_flags";
}
