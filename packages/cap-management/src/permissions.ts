// @wardenx/cap-management — M26 permission-key catalog (§4.6). The authoritative list of every permission
// key Module 26 owns; the backend re-exports this and registers it into M3's catalog (the M27
// `M27_PERMISSIONS` precedent). Keys use the platform `resource.action` dot form. `cap.period.manage` /
// `cap.settlement.manage` (finalize) additionally require M2 step-up at the route layer (D12) — the key
// grants the capability, step-up gates the action.
export const M26_PERMISSIONS = [
  // cap-period lifecycle
  "cap.period.read",
  "cap.period.manage",
  // projection reads + manual recompute
  "cap.projection.read",
  "cap.projection.recompute",
  // accrual ledger reads
  "cap.accrual.read",
  // threshold-event queue
  "cap.event.read",
  "cap.event.acknowledge",
  // PS&R reconciliation
  "cap.psr.import",
  "cap.psr.read",
  "cap.psr.reconcile",
  // settlement
  "cap.settlement.read",
  "cap.settlement.manage",
  // platform constants (platform-admin only)
  "cap.platform_constant.read",
  "cap.platform_constant.manage",
] as const;

export type M26PermissionKey = (typeof M26_PERMISSIONS)[number];
