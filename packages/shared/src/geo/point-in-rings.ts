// @wardenx/shared - even-odd ray-cast point-in-polygon over GeoJSON-style rings (`[[[lng,lat], ...], ...]`,
// WGS-84), the one implementation M20 (high-risk areas) and M40 (tenant-curated PSAP jurisdictions) share.
//
// The first ring is the outer boundary; further rings are holes, so a point inside an odd number of rings is
// inside the polygon. A ring with fewer than three points bounds no area and matches nothing rather than
// throwing: one degenerate saved shape must not take down a read over data the tenant can fix.
import type { SafetyPolygonRings } from "@wardenx/types";

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
