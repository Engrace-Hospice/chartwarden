// apps/backend/src/modules/12-dosespot/seams/as-of.ts — VN-D11 (visit-note drafting) the pure as-of read
// kernel behind `MedicationOrderProvider.getMedicationsAsOf` / `getMedicationChangesBetween`. A late visit note
// describes the regimen at the visit time, so an order's membership is decided from its own instants and never
// from its status today. Pure data in / data out over the patient's order DTOs (the providers feed it the store's
// `medicationOrdersForPatient`); the module's instant comparisons are numeric, never string order.
//
// THE MODEL. An order is in effect from `activatedAt` (inclusive; the instant it became clinically effective, not
// when it was signed: a signed order that owes a transmission is "genuinely not ready to give") until the first of
//   • its own `discontinuedAt` or `completedAt`,
//   • the `activatedAt` of an ACTIVATED order that replaces it (`replacesMedicationOrderId`): a correction does not
//     stamp the predecessor, so without this a corrected dose would be listed twice,
// whichever is earliest (exclusive). FAIL CLOSED: an order whose status says it ended but that carries no end
// instant cannot be placed in time, so it is in effect at no instant and reports no change.
import type {
  MedicationChangeKind,
  MedicationOrderChange,
  MedicationOrderDto,
} from "@chartwarden/types";

/** The parsed instant of a caller-supplied bound, or a `RangeError` (a malformed instant is a caller bug). */
export function parseInstantOrThrow(label: string, iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${label} must be an ISO instant, got ${JSON.stringify(iso)}`);
  }
  return ms;
}

/** A stored instant as ms, or null when absent (a stored value that does not parse is also absent). */
function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The order's own recorded end: the earlier of discontinued / completed, with which one it was. */
function ownEnd(order: MedicationOrderDto): {
  readonly ms: number;
  readonly iso: string;
  readonly kind: "discontinued" | "completed";
} | null {
  const stopped = ms(order.discontinuedAt);
  const completed = ms(order.completedAt);
  if (stopped !== null && (completed === null || stopped <= completed)) {
    return { ms: stopped, iso: order.discontinuedAt as string, kind: "discontinued" };
  }
  if (completed !== null) {
    return { ms: completed, iso: order.completedAt as string, kind: "completed" };
  }
  return null;
}

/** Status says the order ended, yet no end instant was recorded: it cannot be placed in time. */
function isUnplaceable(order: MedicationOrderDto): boolean {
  return (
    (order.status === "discontinued" || order.status === "completed") && ownEnd(order) === null
  );
}

/** The instant an ACTIVATED replacement took over from `order`, or null when none did. */
function replacedAt(order: MedicationOrderDto, all: readonly MedicationOrderDto[]): number | null {
  let earliest: number | null = null;
  for (const other of all) {
    if (other.replacesMedicationOrderId !== order.id) continue;
    const start = ms(other.activatedAt);
    if (start !== null && (earliest === null || start < earliest)) earliest = start;
  }
  return earliest;
}

/** Orders in effect at `asOfMs`, ascending by activation then id. */
export function medicationsAsOf(
  orders: readonly MedicationOrderDto[],
  asOfMs: number,
): MedicationOrderDto[] {
  return orders
    .filter((order) => {
      const start = ms(order.activatedAt);
      if (start === null || start > asOfMs || isUnplaceable(order)) return false;
      const ends = [ownEnd(order)?.ms ?? null, replacedAt(order, orders)].filter(
        (end): end is number => end !== null,
      );
      return ends.every((end) => end > asOfMs);
    })
    .sort(
      (a, b) =>
        (ms(a.activatedAt) as number) - (ms(b.activatedAt) as number) || a.id.localeCompare(b.id),
    );
}

/** Whether `predecessor` was in effect when the order replacing it activated at `replacementStartMs`. */
function wasInEffectBefore(
  predecessor: MedicationOrderDto | undefined,
  replacementStartMs: number,
): boolean {
  if (predecessor === undefined || isUnplaceable(predecessor)) return false;
  const start = ms(predecessor.activatedAt);
  if (start === null || start >= replacementStartMs) return false;
  const end = ownEnd(predecessor);
  return end === null || end.ms >= replacementStartMs;
}

const inWindow = (at: number, fromMs: number, toMs: number): boolean => at > fromMs && at <= toMs;

/** Regimen changes in `(fromMs, toMs]`, ascending by instant (then order id, then kind, for a stable order). */
export function medicationChangesBetween(
  orders: readonly MedicationOrderDto[],
  fromMs: number,
  toMs: number,
): MedicationOrderChange[] {
  const byId = new Map(orders.map((o) => [o.id, o] as const));
  const changes: Array<MedicationOrderChange & { readonly atMs: number }> = [];
  for (const order of orders) {
    const start = ms(order.activatedAt);
    if (start === null || isUnplaceable(order)) continue;
    if (inWindow(start, fromMs, toMs)) {
      const replaced = order.replacesMedicationOrderId;
      const kind: MedicationChangeKind =
        replaced !== null && wasInEffectBefore(byId.get(replaced), start) ? "changed" : "started";
      changes.push({ kind, at: order.activatedAt as string, atMs: start, order });
    }
    const end = ownEnd(order);
    const supersededAt = replacedAt(order, orders);
    // A stop recorded after a replacement had already taken over is not a change to the regimen.
    if (
      end !== null &&
      (supersededAt === null || end.ms <= supersededAt) &&
      inWindow(end.ms, fromMs, toMs)
    ) {
      changes.push({ kind: end.kind, at: end.iso, atMs: end.ms, order });
    }
  }
  return changes
    .sort(
      (a, b) =>
        a.atMs - b.atMs || a.order.id.localeCompare(b.order.id) || a.kind.localeCompare(b.kind),
    )
    .map(({ atMs: _atMs, ...change }) => change);
}
