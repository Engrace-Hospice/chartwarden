// @wardenx/quality — M30 HQRP & Quality: the permission-key catalog (§4.6).
//
// The authoritative list of every permission key Module 30 owns. In a LATER phase the backend
// re-exports this and registers it into Module 3's catalog via `permissionRegistry.declare(30, [...])`;
// any route or seam handler that references a key NOT in this list fails at boot via `assertDeclared`.
// P2a ships only the pure constant catalog (no registration, no Fastify) — this is the source of truth
// the backend projects from (the M33 `M33_PERMISSIONS` precedent, kept as a flat ordered tuple).
//
// Keys mirror §4.6 verbatim and match the §6.1–§6.6 permissions matrix and the §4.1 route inventory.

/**
 * The §4.6 permission keys M30 owns, as an ordered literal tuple. Grouped by subdomain (quality
 * measures, CAHPS, QAPI, SRA, incidents, mortality, CoP compliance, infection, risk register).
 */
export const M30_PERMISSIONS = [
  // Quality measures (§6.1)
  "quality.measure.read",
  "quality.measure.recompute",
  "quality.measure.audit",
  // CAHPS (§6.2) — `quality.cahps.system` is service-only (bound to the vendor adapter's mTLS
  // service account at boot, never granted to a human principal).
  "quality.cahps.read",
  "quality.cahps.admin",
  "quality.cahps.system",
  // QAPI (§6.3) — `qapi.close` (PIP) requires two-person co-sign (QAPI Coordinator + Medical Director).
  "qapi.read",
  "qapi.write",
  "qapi.admin",
  "qapi.close",
  // SRA (§6.4) — `sra.close` requires two-person co-sign (Security Officer + Compliance Officer).
  "sra.read",
  "sra.write",
  "sra.admin",
  "sra.close",
  // Incidents (§6.5)
  "incident.read",
  "incident.write",
  "incident.submit",
  "incident.triage",
  "incident.investigate",
  "incident.cap",
  "incident.resolve",
  "incident.close",
  "incident.reopen",
  "incident.abuse_review",
  // Mortality (§6.6)
  "mortality.read",
  "mortality.write",
  "mortality.close",
  // CoP compliance (§6.6)
  "cop.read",
  "cop.write",
  // Infection (§6.6)
  "infection.read",
  "infection.write",
  // Risk register (§6.6)
  "risk.read",
  "risk.admin",
] as const;

/** Union of the M30 permission keys (§4.6). */
export type M30Permission = (typeof M30_PERMISSIONS)[number];
