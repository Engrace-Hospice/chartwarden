// @chartwarden/shared - even-odd ray-cast point-in-polygon over GeoJSON-style rings (`[[[lng,lat], ...], ...]`,
// WGS-84), the one implementation M20 (high-risk areas) and M40 (tenant-curated PSAP jurisdictions) share.
//
// The first ring is the outer boundary; further rings are holes, so a point inside an odd number of rings is
// inside the polygon. A ring with fewer than three points bounds no area and matches nothing rather than
// throwing: one degenerate saved shape must not take down a read over data the tenant can fix.
import type { SafetyPolygonRings } from "@chartwarden/types";

const MIN_RING_POINTS = 4; // a closed triangle repeats its first point

/** Structural validity of a saved polygon: at least one ring, each closed, >= 4 points, within WGS-84 range. */
export function ringsAreValid(rings: unknown): rings is SafetyPolygonRings {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  return rings.every((ring) => {
    if (!Array.isArray(ring) || ring.length < MIN_RING_POINTS) return false;
    const finite = ring.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        Math.abs(p[0]) <= 180 &&
        Math.abs(p[1]) <= 90,
    );
    if (!finite) return false;
    const first = ring[0] as readonly [number, number];
    const last = ring[ring.length - 1] as readonly [number, number];
    return first[0] === last[0] && first[1] === last[1];
  });
}

/** Axis-aligned bounding-box area in square degrees: a cheap "smaller polygon is more specific" tiebreak. */
export function ringsBoundingArea(rings: SafetyPolygonRings): number {
  const outer = rings[0] ?? [];
  if (outer.length === 0) return Number.POSITIVE_INFINITY;
  const lngs = outer.map((p) => p[0]);
  const lats = outer.map((p) => p[1]);
  return (Math.max(...lngs) - Math.min(...lngs)) * (Math.max(...lats) - Math.min(...lats));
}

export function pointInRings(
  rings: SafetyPolygonRings,
  point: { readonly latitude: number; readonly longitude: number },
): boolean {
  let inside = false;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let ringInside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as readonly [number, number];
      const [xj, yj] = ring[j] as readonly [number, number];
      const intersects =
        yi > point.latitude !== yj > point.latitude &&
        point.longitude < ((xj - xi) * (point.latitude - yi)) / (yj - yi) + xi;
      if (intersects) ringInside = !ringInside;
    }
    if (ringInside) inside = !inside;
  }
  return inside;
}
