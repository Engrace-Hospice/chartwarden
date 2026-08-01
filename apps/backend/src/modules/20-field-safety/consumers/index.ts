// apps/backend/src/modules/20-field-safety/consumers — the upstream bindings (M20-T04, §4.4 / §4.8).
//
//   • ./schedule-plan      the shared vocabulary: visit anchors, a proposed row, a TARGETED mutation
//   • ./m17-visit-cadence  §7.1 — publish materializes, assignment re-points, completion retires
//   • ./m17-no-show        §4.8 — the warn-severity supervisor inquiry, bounded by what M20 can say
//   • ./m18-evv-brackets   §7.1 — arrival re-anchors the cadence, check-out opens the post-visit window
//   • ./m18-gps-spoof      §7.7 — the 12-hour defensive badge (M18 owns the response, M20 shows it)
//   • ./m19-after-hours    §7.5 D14 — the on-call parallel recipient set, three-valued
//   • ./seam-context       the IO half: the M17 / M18 / M5 reads behind the M1 registry
//
// TWO SUBSCRIBED TOPICS HAVE NO CONSUMER HERE, ON PURPOSE:
//
//   • `m19.oncall_shift.activated` / `.completed`. They exist in `M20_SUBSCRIBED_EVENT_NAMES` as the
//     re-sync trigger for a cached on-call resolution — and M20 CACHES NONE. The D14 union is resolved
//     LIVE at fan-out (`./m19-after-hours`), one seam call on a path that is already dialling a voice
//     call, because a cached roster is a 3 a.m. staleness bug: the shift that ended at midnight would keep
//     receiving the SOS and the RN who took over would not. There is nothing to re-sync, so there is
//     nothing to consume.
//
//   • `m36.notification.delivery_failed` and `m5.patient.deceased` are M20-T06's (the M36 alert wiring and
//     the §4.8 delivery-failed escalation), not part of the M17/M18/M19 binding this task owns.
export * from "./m17-no-show";
export * from "./m17-visit-cadence";
export * from "./m18-evv-brackets";
export * from "./m18-gps-spoof";
export * from "./m19-after-hours";
export * from "./schedule-plan";
export * from "./seam-context";
