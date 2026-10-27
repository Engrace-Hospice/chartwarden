# M41 organization erasure (#838)

All 16 M41 tables (`commercial_payer_plan`, `_payer_route`, `_contract_rate`, `_payer_enrollment`, `_eligibility_check`, `_authorization`, `_claim`, `_claim_line`, `_claim_state_history`, `_validation_run`, `_validation_result`, `_validation_override`, `_submission`, `_acknowledgment`, `_ack_quarantine`, `_ack_cursor`) reference `organization` with `ON DELETE RESTRICT`, and had no destruction-role access, so an org-destruction run would have died on the first FK violation.

- Migration 1287 mirrors 1281: per table, `GRANT SELECT, DELETE` to `chartwarden_destruction` plus a `<table>_destruction` policy pinned on `app.org_id`. The app role is not widened.
- `commercial_claim.latest_validation_run_id` and `commercial_validation_run.claim_id` reference each other with non-deferrable RESTRICT FKs. The eraser nulls the claim's run pointer first; 1287 grants the destruction role a column-limited `UPDATE (latest_validation_run_id)` for that one step.
- No trigger blocks the destruction role: the state guard fires on `UPDATE OF state`, the 1286 quarantine delete guard only for `current_user = 'chartwarden_app'` (so an unresolved quarantine row is erasable), and the audit triggers are SECURITY DEFINER inserts.
- `createDrizzleCommercialBillingEraseStore(tx).eraseOrgCommercialBilling({ organizationId })` (`modules/41-billing-commercial/erasers/`) deletes children first and returns per-table counts. Like M23's `eraseOrgBillingConfig`, it is NOT yet bound to an M4 org-destruction driver (none exists for M23 either).
- Proved live as the real `chartwarden_destruction` role in `m41-commercial-submission.live.test.ts` ("org erasure"): org A empty in all 16 tables, org B untouched.
- `commercial_validation_override` is covered by grants/eraser but not seeded by the live test (its 5-column composite FK needs an override flow the suite does not exercise).
