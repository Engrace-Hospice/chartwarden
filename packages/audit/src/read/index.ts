// @chartwarden/audit — capture path: PHI read auditing (§2.1 "read at handler", §3.4, §2.5).
//
// The route-facing read-capture surface, layered on the M1 `auditRead()` primitive (../audit):
//   audit-read.ts         — `auditPhiRead()` / `auditListRead()`: the §164.528-aware read
//                           capture helpers every PHI read route calls (§3.4).
//   require-read-audit.ts — the read-audit-completeness declaration surface every PHI read
//                           route satisfies, enforced by the §2.5 build-time lint.
export * from "./audit-read";
export * from "./require-read-audit";
export * from "./route-config";
