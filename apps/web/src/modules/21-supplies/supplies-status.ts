// apps/web/src/modules/21-supplies — shared status presentation for the M21 Supplies / DME / Comfort-Kit
// surfaces (Track B / ADR-0030, §5 / DESIGN.md §6.6). Every M21 screen renders the same StatusPill for a
// given wire enum through these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M15
// discipline-status.ts / M16 bereavement-status.ts precedent).
//
// Every key below is a value from the FROZEN pgEnum list in packages/db/src/enums.ts (M21-T01) — not from
// the prose spec, which drifts from the columns in three places (`m21_delivery_method`,
// `m21_pharmacy_dispatch_mode`, `m21_fulfillment_mode`; see the M21-T05 notes). A wire value a map does not
// carry falls through to `neutral` rather than throwing, but a *silently wrong vocabulary* is the failure
// mode these maps exist to prevent, so the source of each map is named.
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/complete · warning≈needs-attention ·
// error≈breached/failed · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@wardenx/ui";

/** `m21_supply_request_status` (§2.2 / D2) — the fulfillment machine. `cancellation_pending` is `progress`,
 *  not `neutral`: the vendor has been ASKED and has not answered, so the row is still in flight — reading it
 *  as terminal is precisely the mistake §2.2 introduced the state to prevent (a DME already on the truck
 *  cannot be un-shipped by our writing `cancelled`). */
export const REQUEST_STATUS_TONE: Record<string, StatusTone> = {
  requested: "warning",
  vendor_assigned: "progress",
  ordered: "progress",
  in_transit: "progress",
  delivered: "progress",
  received_confirmed: "success",
  completed: "neutral",
  cancellation_pending: "progress",
  cancelled: "neutral",
  returned: "neutral",
};

/** The §2.2 NON-terminal set — what `openOnly=true` narrows to, mirrored here only for the dashboard's
 *  "needs my action" copy. The server decides the filter; this never re-filters a server page. */
export const OPEN_REQUEST_STATUSES: readonly string[] = [
  "requested",
  "vendor_assigned",
  "ordered",
  "in_transit",
  "delivered",
  "cancellation_pending",
];

/** `m21_supply_request_kind` (D1). */
export const REQUEST_KINDS: readonly string[] = [
  "dme",
  "supply",
  "comfort_kit_deploy",
  "comfort_kit_replenish",
];

/** The two kinds that produce a `comfort_kit_dispatch` — the ones §4.4 gates with
 *  `controlled_substance_dispatcher_eligible` at create time. */
export const KIT_REQUEST_KINDS: readonly string[] = ["comfort_kit_deploy", "comfort_kit_replenish"];

/** `m21_comfort_kit_dispatch_status` (M21-F04). `reconciled_with_discrepancy` is a SEPARATE terminal from
 *  `reconciled` (not a flag on it), so it reads as `error`: an unexplained controlled-substance shortfall is
 *  a survey finding, not a completed kit. */
export const DISPATCH_STATUS_TONE: Record<string, StatusTone> = {
  dispatched: "progress",
  deployed_at_patient: "success",
  partially_returned: "warning",
  fully_returned: "progress",
  reconciled: "neutral",
  reconciled_with_discrepancy: "error",
};

/** `m21_return_state` (§2.6 / D8). `overdue` and `unreturnable` are STATES, not flags — a kit that never
 *  came back is a survey-reportable disposition, which is why `unreturnable` reads `error` and not
 *  `neutral` despite being terminal. */
export const RETURN_STATE_TONE: Record<string, StatusTone> = {
  requested: "warning",
  assigned: "progress",
  retrieving: "progress",
  retrieved: "progress",
  reconciled: "neutral",
  overdue: "error",
  unreturnable: "error",
};

/** The §2.6 states that still owe a physical count — the reconciliation worklist's live set. */
export const OPEN_RETURN_STATES: readonly string[] = [
  "requested",
  "assigned",
  "retrieving",
  "retrieved",
  "overdue",
];

/** The DERIVED par band (§2.7 / D5). Never stored — a stored severity goes stale the moment a threshold is
 *  edited, and the screen reading it would show a green shelf that is actually empty. */
export const PAR_SEVERITY_TONE: Record<string, StatusTone> = {
  ok: "success",
  below_threshold: "warning",
  critical_low: "error",
  depleted: "error",
};

/** A par band's ICON — Hard Rule §10.10: a shelf state is never signalled by colour alone. */
export const PAR_SEVERITY_GLYPH: Record<string, string> = {
  ok: "●",
  below_threshold: "◕",
  critical_low: "◐",
  depleted: "○",
};

/** The four bands in escalation order, for the dashboard's low-watermark sort. */
export const PAR_SEVERITY_RANK: Record<string, number> = {
  depleted: 0,
  critical_low: 1,
  below_threshold: 2,
  ok: 3,
};

/** `m21_controlled_substance_schedule` (21 CFR §1308). CII is the most diversion-exposed and reads as the
 *  strongest signal; there is no CI, because a CI substance has no accepted medical use. */
export const SCHEDULE_TONE: Record<string, StatusTone> = {
  CII: "error",
  CIII: "warning",
  CIV: "warning",
  CV: "neutral",
};

export const CONTROLLED_SCHEDULES: readonly string[] = ["CII", "CIII", "CIV", "CV"];

/** `m21_routing_scope_kind` (D4), most specific FIRST — this array order IS the precedence ladder the
 *  routing admin renders, so it must not be re-sorted alphabetically. */
export const ROUTING_SCOPES: readonly string[] = ["sku", "location", "tenant", "platform"];

/** The three scopes a TENANT may author. `platform` is absent from the write path by design: the TypeBox
 *  union omits it and the RLS write policy would refuse it anyway (two gates, §3.1.5). */
export const TENANT_ROUTING_SCOPES: readonly string[] = ["sku", "location", "tenant"];

/** `m21_fulfillment_mode` (D4). Only `vendor` requires a non-null vendor id; on the other three a null
 *  vendor is CORRECT, not an unresolved routing failure. */
export const FULFILLMENT_MODES: readonly string[] = [
  "vendor",
  "internal_supply_hub",
  "partner_pharmacy",
  "dosespot_to_partner_pharmacy",
];

/** `m21_pharmacy_dispatch_mode` (D6) — who physically fills the kit. */
export const PHARMACY_DISPATCH_MODES: readonly string[] = [
  "supply_hub_dispatch",
  "partner_pharmacy_dispatch",
  "dosespot_to_partner_pharmacy",
];

/** `m21_dispatch_source` (D6) — which DEA registration the kit physically left from. */
export const DISPATCH_SOURCES: readonly string[] = [
  "supply_hub",
  "pharmacy_partner",
  "dosespot_pharmacy",
];

/** `m21_deployment_site` (D17). `ipu_room` is the only value carrying an IPU room and the only one with no
 *  patient delivery address. */
export const DEPLOYMENT_SITES: readonly string[] = ["home", "alf", "snf_residence", "ipu_room"];

/** `m21_delivery_method` (D7) — how the item physically reached the patient. */
export const DELIVERY_METHODS: readonly string[] = [
  "agency_courier",
  "vendor_direct_ship",
  "pharmacy_partner_courier",
  "patient_pickup",
  "in_facility_internal",
];

/** `m21_supply_received_confirmed_actor` MINUS `system_auto_confirm` (§4.2). The 72h fallback is the
 *  worker's to write; offering it here would let a screen record an unattended auto-confirm as a human one,
 *  erasing exactly the distinction the request detail renders. */
export const RECEIPT_ACTORS: readonly string[] = ["caregiver", "patient", "supply_team"];

/** `m21_disposal_method` (§1.3 / DEA 21 CFR §1317). */
export const DISPOSAL_METHODS: readonly string[] = [
  "take_back_by_supply_team",
  "dispose_at_home_by_witnessed_destruction",
  "transferred_to_disposing_pharmacy",
];

/** The one disposal method §3.1.10's CHECK requires a witness for — the value with no downstream custodian
 *  to corroborate the count. The form arms its witness field on exactly this value. */
export const WITNESS_REQUIRED_DISPOSAL_METHOD = "dispose_at_home_by_witnessed_destruction";

/** `m21_supply_sku_class` (D11 — the HCPCS letter family). */
export const SKU_CLASSES: readonly string[] = ["E", "A", "B", "K", "L", "Q", "internal"];

/**
 * The default picker selections, named rather than written as `SOME_LIST[0]`. Under
 * `noUncheckedIndexedAccess` an index read is `string | undefined`, which would make every form's initial
 * state nullable for no reason — and a `??` fallback at each call site would put the same literal in five
 * files (the M16-T07 lesson).
 */
export const DEFAULT_DEPLOYMENT_SITE = "home";
export const DEFAULT_DISPATCH_SOURCE = "supply_hub";
export const DEFAULT_PHARMACY_DISPATCH_MODE = "supply_hub_dispatch";
export const DEFAULT_DELIVERY_METHOD = "agency_courier";
export const DEFAULT_RECEIPT_ACTOR = "caregiver";
export const DEFAULT_DISPOSAL_METHOD = "take_back_by_supply_team";
export const DEFAULT_FULFILLMENT_MODE = "vendor";
export const DEFAULT_ROUTING_SCOPE = "tenant";
export const DEFAULT_SKU_CLASS = "E";

/** `transaction_kind` on a §8.1 DEA perpetual-log entry. */
export const LOG_KIND_TONE: Record<string, StatusTone> = {
  dispense: "progress",
  administer_drawdown: "neutral",
  return: "success",
  disposal: "neutral",
  adjustment: "warning",
};

/** A request kind → the coordinator-facing label. */
export function requestKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "dme":
      return "DME";
    case "supply":
      return "Supply";
    case "comfort_kit_deploy":
      return "Comfort kit — deploy";
    case "comfort_kit_replenish":
      return "Comfort kit — replenish";
    default:
      return humanize(kind);
  }
}

/** A deployment site → its label. `snf_residence` is a SNF the patient LIVES in, not an IPU bed. */
export function deploymentSiteLabel(site: string | null | undefined): string {
  switch (site) {
    case "home":
      return "Home";
    case "alf":
      return "Assisted living";
    case "snf_residence":
      return "SNF (residence)";
    case "ipu_room":
      return "IPU room";
    default:
      return humanize(site);
  }
}

/** A par band → the shelf sentence a coordinator can act on. */
export function parSeverityLabel(severity: string | null | undefined): string {
  switch (severity) {
    case "ok":
      return "At par";
    case "below_threshold":
      return "Below reorder point";
    case "critical_low":
      return "Critical low";
    case "depleted":
      return "Depleted";
    default:
      return humanize(severity);
  }
}

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — "" is a valid key). */
export function toneOf(
  map: Record<string, StatusTone>,
  key: string | null | undefined,
): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/upper wire enum for display (`vendor_assigned` → "Vendor assigned"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** A date + HH:MM label for an instant. */
export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** A short opaque id label for an identifier surfaced in a queue column. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 8);
}

/** Whole days between now and an instant — negative when the instant has passed. */
export function daysUntil(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return Math.floor((ms - now) / 86_400_000);
}

/** Whole days SINCE an instant — the age-in-status column (0 when the instant is in the future). */
export function ageInDays(value: string | null | undefined, now = Date.now()): number {
  const days = daysUntil(value, now);
  if (days === null) return 0;
  return days >= 0 ? 0 : -days;
}

/** A relative-due label for the return worklist and the delivery window. */
export function dueLabel(value: string | null | undefined, now = Date.now()): string {
  const days = daysUntil(value, now);
  if (days === null) return "—";
  if (days === 0) return "due today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  const overdue = -days;
  return `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
}

/**
 * Decimal-string arithmetic for the D8 reconciliation preview. The quantities are `numeric` columns carried
 * as STRINGS on the wire (§4.2), and the SERVER's `m21_compute_return_discrepancy()` is the only authority
 * on what gets stored — this is a preview so the reconciler can see the consequence of a count BEFORE they
 * commit it, never a value that is sent back.
 *
 * Parsing to a float here is acceptable *for a preview label* and nowhere else; the string is what travels.
 */
export function unaccountedPreview(
  dispatched: string,
  returned: string,
  disposedAtHome: string,
): { unaccounted: number; pct: number } | null {
  const d = Number(dispatched);
  const r = Number(returned);
  const h = Number(disposedAtHome);
  if (!Number.isFinite(d) || !Number.isFinite(r) || !Number.isFinite(h) || d <= 0) return null;
  const unaccounted = d - r - h;
  return { unaccounted, pct: (Math.abs(unaccounted) / d) * 100 };
}

/**
 * `comfort_kit_returned_content.discrepancy_pct` and `comfort_kit_template_medication
 * .replenishment_threshold_pct` are named "pct" and hold a FRACTION in [0,1] — the D8 trigger compares
 * against `0.05`, and §3.1.4's CHECK bounds the threshold to [0,1]. The columns win over their own names,
 * and the wire carries them raw.
 *
 * So a screen must convert before it prints a "%" sign. Rendering the stored 0.333 under a column headed
 * "Discrepancy %" would read as a third of a percent — a hundredfold understatement of a
 * controlled-substance shortfall, sitting next to a preview column computed in real percent. This is the
 * one place the conversion lives.
 */
export function fractionAsPct(value: string | number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

/** The D8 threshold. A line at or above it on a CONTROLLED substance is what fires
 *  `m21.controlled_substance.discrepancy_detected` — the server computes and stores the flag; this only
 *  decides whether the form warns before the count is committed. */
export const DISCREPANCY_THRESHOLD_PCT = 5;

/** Does the previewed count cross D8 on a controlled line? Non-controlled lines never raise the banner. */
export function crossesDiscrepancyThreshold(
  isControlled: boolean,
  preview: { pct: number } | null,
): boolean {
  return isControlled && preview !== null && preview.pct >= DISCREPANCY_THRESHOLD_PCT;
}
