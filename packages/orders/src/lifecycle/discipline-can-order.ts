// @wardenx/orders — §2.1 / §4.7 `discipline_can_order` (M11-T03). Pure, IO-free.
//
// Who may AUTHOR (draft + request signature for) a given order kind. Drafting is broader than signing: a
// clinical discipline in the kind's signer matrix may always draft it, and an `lpn` may draft the clinical
// kinds (lab / dme / comfort_kit / supply / ancillary_service) — but an LPN-drafted clinical order then
// carries an RN-cosign requirement before it can be signed (§2.5 axis 1, ./cosign-rules). The signing
// gate itself is the stricter ./signer-eligible predicate. This decision reads the single-source
// `KIND_CATALOG` (no inline re-derivation) and is consumed by the §4.7 ABAC predicate at the route.
import type { OrderKind } from "@wardenx/types";
import { KIND_CATALOG, type OrderSignerDiscipline } from "../catalog";
import { require_ } from "./errors";

/** A drafting discipline: every signer discipline, plus `lpn` (drafts clinical kinds, cosigned by an RN). */
export type OrderDrafterDiscipline = OrderSignerDiscipline | "lpn";

/** §2.5 — the clinical kinds an `lpn` may draft (the default `lpn_cosign_required_kinds` set). */
export const LPN_DRAFTABLE_KINDS = [
  "lab",
  "dme",
  "comfort_kit",
  "supply",
  "ancillary_service",
] as const satisfies readonly OrderKind[];

/** Normalize a free-text discipline to the lower-case key the matrix compares. */
function key(discipline: string): string {
  return discipline.trim().toLowerCase();
}

/**
 * §2.1 / §4.7 — whether `drafterDiscipline` may author (draft + request signature for) `kind`. True when
 * the discipline is in the kind's signer matrix, or it is an `lpn` drafting one of the {@link
 * LPN_DRAFTABLE_KINDS} (RN cosign then gates the signature). The `idg_requested` intake kind is authored
 * by an RN case manager / clinical supervisor per its catalog entry (resolve/redirect only).
 */
export function disciplineCanOrder(drafterDiscipline: string, kind: OrderKind): boolean {
  const d = key(drafterDiscipline);
  const inMatrix = (KIND_CATALOG[kind].signerDisciplines as readonly string[]).includes(d);
  if (inMatrix) return true;
  return d === "lpn" && (LPN_DRAFTABLE_KINDS as readonly string[]).includes(kind);
}

/** Guard the draft / request-signature path on authoring eligibility (raises `DISCIPLINE_CANNOT_ORDER`). */
export function assertDisciplineCanOrder(drafterDiscipline: string, kind: OrderKind): void {
  require_(
    disciplineCanOrder(drafterDiscipline, kind),
    "DISCIPLINE_CANNOT_ORDER",
    `Discipline '${drafterDiscipline}' may not author a '${kind}' order (§2.1 signer matrix).`,
  );
}
