// apps/web/src/modules/23-billing-medicare — read a validation result's stored remediation (`validation_result.
// remediation`, jsonb) into one shape. Current rows are FLAT ({ summary, fixAction, fixDeepLink, observed?,
// defects? }); rows a re-validation wrote before the storage fix nest it ({ remediation: {...}, observed }), so a
// re-validated result's summary used to be invisible on the worklist. Both shapes read the same here.
import type { MissingDischargeDetail } from "../../shell/discharge-claim-codes";
import { MISSING_DETAIL_DEFECTS } from "./discharge-attention";

export interface RemediationDefect {
  code: string;
  message: string;
  refs?: Record<string, string>;
}

export interface Remediation {
  summary?: string;
  blameTarget?: string;
  blameTargetId?: string;
  fixAction?: string;
  fixDeepLink?: string;
  defects?: RemediationDefect[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function defectsOf(v: unknown): RemediationDefect[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((d) => {
    const o = d as { code?: unknown; message?: unknown; refs?: unknown } | null;
    if (!o || typeof o.code !== "string") return [];
    const refs =
      o.refs && typeof o.refs === "object"
        ? Object.fromEntries(
            Object.entries(o.refs as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : undefined;
    return [{ code: o.code, message: str(o.message) ?? "", ...(refs ? { refs } : {}) }];
  });
}

/** Deliberate defence in depth: the backend already aliases this on read (@chartwarden/billing legacy-stored-aliases); the web keeps its
 *  own copy so a raw stored value can never reach the dispatcher un-mapped, and to avoid pulling the server package into the web bundle.
 *  Stored fix actions written before the hipps_* -> per_diem_* rename (migration 1069; history is not rewritten). */
const LEGACY_FIX_ACTIONS: Readonly<Record<string, string>> = {
  recompute_hipps: "recompute_per_diem_class",
};

export function canonicalFixAction(stored: string | undefined): string | undefined {
  return stored !== undefined && Object.hasOwn(LEGACY_FIX_ACTIONS, stored)
    ? LEGACY_FIX_ACTIONS[stored]
    : stored;
}

export function normalizeRemediation(raw: unknown): Remediation | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as Record<string, unknown>;
  const nested =
    outer.remediation && typeof outer.remediation === "object"
      ? (outer.remediation as Record<string, unknown>)
      : null;
  const r = nested ?? outer;
  const defects = defectsOf(outer.defects) ?? defectsOf(r.defects);
  const out: Remediation = {
    summary: str(r.summary),
    blameTarget: str(r.blameTarget),
    blameTargetId: str(r.blameTargetId),
    fixAction: canonicalFixAction(str(r.fixAction)),
    fixDeepLink: str(r.fixDeepLink),
    ...(defects ? { defects } : {}),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : null;
}

/** The missing discharge detail a run's failures name (the first one), with what the guided panel needs. */
export function missingDischargeDetailOf(
  results: readonly { outcome: string; overridden: boolean; remediation: unknown }[],
): { detail: MissingDischargeDetail; admissionId: string; fixDeepLink: string | null } | null {
  for (const r of results) {
    if (r.outcome !== "fail" || r.overridden) continue;
    const rem = normalizeRemediation(r.remediation);
    for (const d of rem?.defects ?? []) {
      const detail = MISSING_DETAIL_DEFECTS[d.code];
      const admissionId = d.refs?.admissionId ?? rem?.blameTargetId;
      if (detail && admissionId) {
        return { detail, admissionId, fixDeepLink: rem?.fixDeepLink ?? null };
      }
    }
  }
  return null;
}
