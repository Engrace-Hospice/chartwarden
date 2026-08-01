// apps/backend/src/modules/19-oncall/consumers — the D10 inbound triggers (M19-T04).
//
// Two upstream events open a proactive triage call, and binding them is what closes M17's and M18's
// Phase-1 deny-stub consumers (Wave P2-2 acceptance #2):
//
//   • ./m17-no-show        §7.6 — `m17.visit.no_show_detected` → a `source='no_show'` welfare-check call
//   • ./m18-late-checkout  §4.8 — `m18.evv.late_check_out_detected` → a `source='late_checkout'` call
//   • ./inbound-trigger    the rules both share: the three-way dedupe, the coverage verdict, and the draft
//   • ./trigger-context    the IO half — the M17 seam read-backs, behind the M1 registry
//
// M19-T07 adds the third:
//   • ./m36-delivery-failed §4.8 — `m36.notification.delivery_failed` WITH an on-call recipient. It does
//     NOT reuse `decideInboundTrigger`: a delivery failure describes a MESSAGE, not a visit, and when the
//     undelivered alert named an M19 call the response is to escalate THAT call rather than fork the
//     narrative of one 2 a.m. event across two records.
export * from "./inbound-trigger";
export * from "./m17-no-show";
export * from "./m18-late-checkout";
export * from "./m36-delivery-failed";
export * from "./trigger-context";
