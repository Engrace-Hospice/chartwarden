// @chartwarden/mdm — the canonical + this-tenant overlay join (M40-T04, spec §2.1, §2.3).
//
// The §2.1 read path's JOIN node: after the redirect chase lands on a surviving canonical row,
// fold in this tenant's overlay (if any) to produce the canonical-plus-overlay shape every
// consumer reads. Pure and generic over the per-kind canonical/overlay payloads — T05 binds the
// concrete `CanonicalFields<K>` / `OverlayFields<K>` from the seam (`MdmResolved<K>`, §4.5) and
// supplies the rows from Drizzle; this engine only owns the *shape* of the combination and the
// §2.3 rule that overlay is optional (a canonical with no overlay row resolves to `overlay:null`).

import type { MergeRedirect, ResolvedStatus } from "./follow-merge";

/**
 * The resolved entity shape (§2.1, §4.5 `MdmResolved`): the surviving canonical id, the optional
 * `resolvedFrom` redirect breadcrumb (§7.2), the canonical payload, and this tenant's overlay
 * (`null` when no overlay row exists — the §2.3 default). Generic over the canonical payload `C`
 * and overlay payload `O`; T05 instantiates it per kind. `status` is the survivor's status,
 * never `merged` (the redirect always resolves through to a live row).
 */
export interface ResolvedEntity<C, O> {
  /** canonical id (after merge-redirect resolution, §7.2) */
  readonly id: string;
  /** present only when the requested id was a merged row; the caller may patch its FK (§7.2) */
  readonly resolvedFrom?: string;
  /** canonical fields — registry-sourced, the same answer for every tenant (§2.3) */
  readonly canonical: C;
  /** this tenant's overlay opinion, or `null` if this tenant has no overlay row (§2.3) */
  readonly overlay: O | null;
  /** survivor status post-redirect — `active` / `deactivated` / `provisional`, never `merged` */
  readonly status: ResolvedStatus;
}

/**
 * Combine a resolved {@link MergeRedirect}, the survivor's canonical payload, and this tenant's
 * overlay row (or `null`) into a {@link ResolvedEntity}. Pure projection — the redirect already
 * decided identity and status; this only attaches the payloads. The `resolvedFrom` breadcrumb is
 * propagated verbatim so a consumer can tell a redirect happened without re-running the chase.
 *
 * Invariant the caller must honor: `canonical` is the payload of the *survivor* row
 * (`redirect.id`), not the originally-requested merged row — overlay-join never re-reads the
 * canonical, it trusts the redirect's resolution (the single-source-of-truth for which row won).
 */
export function joinOverlay<C, O>(
  redirect: MergeRedirect,
  canonical: C,
  overlay: O | null,
): ResolvedEntity<C, O> {
  return redirect.resolvedFrom === undefined
    ? { id: redirect.id, canonical, overlay, status: redirect.status }
    : {
        id: redirect.id,
        resolvedFrom: redirect.resolvedFrom,
        canonical,
        overlay,
        status: redirect.status,
      };
}
