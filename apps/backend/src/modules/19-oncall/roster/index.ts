// apps/backend/src/modules/19-oncall/roster — the on-call roster (M19-T04).
//
//   • ./shift-machine  §2.2.2 / D7 — the `scheduled → active → completed | cancelled` machine, the
//                      policy-snapshot pin at open, and the coverage predicates the §4.8 crons run on
//   • ./shift-sync     §4.5 path 1 / D3 — reconciling M17's `tonightsOnCallRoster` into `on_call_shift`
//                      rows, per ProviderEntity, without ever rewriting a night that already happened
//
// Both are PURE (facts in, plan/effects out). The §4.8 `shift-open.cron` / `shift-close.cron` /
// `shift-sync.debounced` workers that execute them land with the M19-T07 service layer.
export * from "./shift-machine";
export * from "./shift-sync";
