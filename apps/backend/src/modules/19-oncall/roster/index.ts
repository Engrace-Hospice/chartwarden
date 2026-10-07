// apps/backend/src/modules/19-oncall/roster — the on-call roster (M19-T04).
//
//   • ./shift-machine  §2.2.2 / D7 — the `scheduled → active → completed | cancelled` machine, the
//                      policy-snapshot pin at open, and the coverage predicates the §4.8 crons run on
//   • ./shift-sync     §4.5 path 1 / D3 — reconciling M17's `tonightsOnCallRoster` into `on_call_shift`
//                      rows, per ProviderEntity, without ever rewriting a night that already happened
//
//   • ./coverage-gap  §4.8 — the pure `coverage-gap-watchdog` predicate (GAP-057)
//
// All PURE (facts in, plan/effects out). The §4.8 `shift-open.cron` / `shift-close.cron` /
// `coverage-gap-watchdog.cron` / `shift-sync.debounced` workers that execute them live in `../jobs`.
export * from "./shift-machine";
export * from "./shift-sync";
export * from "./coverage-gap";
