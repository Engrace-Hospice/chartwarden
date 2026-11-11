# Remaining blockers

1. **Aggregate completeness:** each owner API contributes a bounded first page and has its own cursor. Counts are loaded-page counts, not tenant-wide totals or a consistent cross-source snapshot.
2. **Worklist scope:** M23 NOE/NOTR/DDE remains in `/billing/queue`; M23/M24/M41 in-doubt submissions, durable cross-module activity and authoritative A/R exceptions are not included.
3. **Quarantine:** central unattributed Claim.MD quarantine remains operator-only and is deliberately invisible here. A tenant-safe attributed quarantine projection needs an owner contract first.
4. **Location:** an authoritative location selector/filter is available only for M25 stage rows in this page. The other claim list contracts need owner-approved location associations and filters.
5. **PostgreSQL HTTP integration:** module private DB suites passed, but no one test joins authenticated workspace HTTP reads across all source owners under two real tenants.
6. **Responsive polish:** the dense table scrolls horizontally on narrow viewports; a dedicated card view and browser-level keyboard/mobile tests remain.

None of these gaps enables financial mutation or exposes global quarantine. They make this an initial operational workspace rather than the full BIL-5 operations/certification scope.
