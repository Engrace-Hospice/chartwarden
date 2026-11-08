# Frontend Billing UX Findings

This is a source-level review of the screens and request contracts. Accessibility runtime behavior was not certified with a browser or assistive-technology session.

## Existing screens and strengths

| Module | Existing screen flow | Evidence |
|---|---|---|
| M23 | Claim assembly wizard → workbench/list → claim editor → validation remediation → history and acknowledgments timeline. | [claim-assembly-wizard.tsx](../../../apps/web/src/modules/23-billing-medicare/claim-assembly-wizard.tsx#L58), [claim-workbench.tsx](../../../apps/web/src/modules/23-billing-medicare/claim-workbench.tsx#L102), [claim-editor.tsx](../../../apps/web/src/modules/23-billing-medicare/claim-editor.tsx#L144), [claim-history.tsx](../../../apps/web/src/modules/23-billing-medicare/claim-history.tsx#L65). |
| M41 | Provider-entity picker → assemble commercial claim → claim queue/detail → validation/send gate → timeline. | [assemble-claim.tsx](../../../apps/web/src/modules/41-billing-commercial/assemble-claim.tsx#L56), [claim-queue.tsx](../../../apps/web/src/modules/41-billing-commercial/claim-queue.tsx), [claim-detail.tsx](../../../apps/web/src/modules/41-billing-commercial/claim-detail.tsx), [claim-send-gate.tsx](../../../apps/web/src/modules/41-billing-commercial/claim-send-gate.tsx), [claim-timeline.tsx](../../../apps/web/src/modules/41-billing-commercial/claim-timeline.tsx). |
| M24 | State/provider-aware Medicaid work queue → claim assembly/editor/workbench → validation queue and acknowledgment/submission timeline. | [claim-workbench.tsx](../../../apps/web/src/modules/24-billing-medicaid/claim-workbench.tsx#L104), [claim-assembly-wizard.tsx](../../../apps/web/src/modules/24-billing-medicaid/claim-assembly-wizard.tsx), [claim-editor.tsx](../../../apps/web/src/modules/24-billing-medicaid/claim-editor.tsx), [submissions-timeline.tsx](../../../apps/web/src/modules/24-billing-medicaid/submissions-timeline.tsx). |

Existing coverage includes DOM tests for M23 assembly/history/queue, M41 assembly/queue/detail/send-gate/timeline, and M24 assembly/editor/queue/validation/timeline. Keep those screens and typed API client contracts; no BIL-5 redesign is needed for BIL-2.

## Concrete workflow UX gaps / risks

1. **Payer route blockers need to be explained before send.** M41 has a dedicated send gate and stable reasons, a reusable pattern for M23 payer mapping and M24 state availability. Expose whether a block is missing data, enrollment verification, unsupported route, or external certification. Do not show a generic “submit failed” when the API can return a stable reason.
2. **M24 needs an early “electronic route unavailable” decision.** The workbench can validate and open claims, but an unsupported state must be surfaced before a user invests in assembly. Keep the state-specific manual alternative alongside the reason and never hide the API refusal.
3. **M41 has no correction completion path.** The timeline can explain past submission/reconciliation, but no replacement action can begin a payer correction. Add only once payer-specific replacement fields and transmission semantics are defined.
4. **M23 previews must represent the final send artifact.** The backend already has an exact 837I loader and typed gaps. The implementation slice should reuse this to make preview and remediation match the actual payload and avoid UI-side duplicate business rules.
5. **Separate “uploaded” from clearinghouse acceptance, payer acceptance and adjudication.** In history/timeline labels, retain source and stage provenance. A successful upload or Claim.MD normalized response must not appear as payer approval.
6. **Cross-module inconsistency:** M23/M24/M41 screens use different status labels, navigation and detail structures. BIL-2 should standardize task-level language, loading/error/empty patterns and actionable remediation only where the user crosses workflows; a global workspace overhaul belongs to BIL-5.

## Accessibility and interaction review limits

Source contains labeled controls, disabled/busy state and error regions in audited screens, and DOM tests exercise portions of these interactions. This audit did not run a browser, keyboard-only, screen-reader, contrast or responsive test. Record these as **Unknown**, not “accessible.” BIL-2.1 should add keyboard/focus assertions for the claim preview/remediation dialog it changes; cumulative accessibility work remains in BIL-5.
