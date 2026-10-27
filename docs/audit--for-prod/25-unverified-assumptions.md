# 25 — Unverified assumptions

| Assumption needing evidence | Status | Reason / required evidence |
|---|---|---|
| Production equals this branch/commit/configuration | NOT_VERIFIED | no host or deployment inventory access |
| All 484 registered live suites pass together | NOT_VERIFIED | targeted subset only; time/isolation constraints |
| Browser workflows work at six viewports | BLOCKED | no isolated full seeded stack |
| WCAG 2.2 AA conformance | BLOCKED | no manual AT/keyboard/zoom/contrast audit |
| Full patient lifecycle is transactionally consistent | NOT_VERIFIED | selected modules only, no full E2E/concurrency |
| MAC accepts generated claims/notices | NOT_VERIFIED | no MAC/DDE sandbox transaction |
| Clearinghouse 837/999/277/TA1/835 correlation works | NOT_VERIFIED | no partner endpoint/credentials |
| Medicaid rules cover every supported state | NOT_VERIFIED | no payer/state certification corpus executed |
| Commercial payer rules are complete | NOT_VERIFIED | contracts/vendor behavior unavailable |
| iQIES accepts HOPE packages/corrections | NOT_VERIFIED | no CMS environment/credentials |
| DoseSpot mappings are vendor-valid | BLOCKED | configured sandbox unavailable |
| FHIR/HL7 partner conformance | NOT_VERIFIED | local contracts only |
| Backups protect production DB and objects | FAIL | repository evidence explicitly says object backup absent |
| Monitoring alerts reach an accountable responder | NOT_VERIFIED | live alert channel/on-call records unavailable |
| Production capacity meets workload | NOT_VERIFIED | no representative load/telemetry |
| HIPAA compliance | NOT_VERIFIED | organizational/operational controls outside code |
| CoP compliance | NOT_VERIFIED | agency policy, practice, and clinical records unavailable |
| No secrets exist in history/external systems | NOT_VERIFIED | working tree scan is not full secret-history/registry audit |
| Dependency licenses are compatible | NOT_VERIFIED | no complete legal/license review |

These are limitations, not implied defects, except where a linked finding supplies affirmative
evidence.
