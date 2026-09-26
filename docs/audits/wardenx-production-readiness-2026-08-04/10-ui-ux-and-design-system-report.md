# UI/UX and Design-System Report

## Overall Assessment

WardenX has a real design system (`@wardenx/ui`), shared tokens, a screen registry, route-level lazy loading in the staff SPA, utility states, permission guards, confirmation ceremonies, and a focus-trapped modal. It does not yet have evidence that 271 screens behave as one complete product. The frame register covers 17 screens, and 14 of those document functional substitutions or missing DTO/write paths.

## UI-001 - Visual and behavioral fidelity is unknown for most screens

- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Category: UI/UX conformance
- Production blocker: No by itself
- Affected workflow: All
- Affected persona: All
- Evidence: Frame report maps 17/271 registered screens; 3 are matched and 14 partial. Only 17/120 design-ledger frames are mapped.
- File(s): `audit/frame-fidelity/FRAME_FIDELITY.md`; `scripts/frame-fidelity/registry.ts`
- Symbol(s): frame fidelity registry
- Description: UI parity proves route/permission registration, not layout, responsive behavior, state completeness, or workflow usability.
- Root cause: Screen implementation outpaced per-frame review and browser QA.
- User impact: Inconsistent hierarchy, density, state handling, and expectations across modules are plausible.
- Technical impact: One-off patterns accumulate without a finish gate.
- Security or data impact: Inconsistent status/ceremony UI can obscure consequence or incomplete actions.
- Recommended remediation: Expand the registry by workflow priority, add screenshot/accessibility acceptance, and review real loaded/empty/error/denied states.
- Tests required: Desktop/mobile visual snapshots, keyboard walkthrough, overflow and zoom checks.
- Dependencies: P0 backend completion before declaring affected screens matched.
- Acceptance criteria: Every launch-critical screen is mapped, reviewed, and has state screenshots at required viewports.

## UI-002 - Bespoke dialogs bypass the canonical accessible modal

- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Category: Accessibility / component drift
- Production blocker: No
- Affected workflow: MAC credential editing and screen lock
- Affected persona: Keyboard and assistive-technology users
- Evidence: Canonical `Modal` traps/restores focus and handles Escape. MAC drawer is a plain `role="dialog"` without `aria-modal`, focus trap, or restoration; screen lock uses a raw dialog overlay without focus containment.
- File(s): `packages/ui/src/web/system/modal.tsx:1-129`; `apps/web/src/modules/23-billing-medicare/mac-credentials.tsx:431-505`; `apps/web/src/modules/02-identity/screen-lock.tsx:89-130`
- Symbol(s): `Modal`, credential drawer, `ScreenLock`
- Description: High-value security/credential interactions do not consistently use the canonical accessible shell.
- Root cause: Feature-local overlays predate or bypassed design-system consolidation.
- User impact: Focus can escape, opening focus is not guaranteed, and keyboard users can lose context.
- Technical impact: Duplicate dialog mechanics.
- Security or data impact: Users may act in the obscured background or miss credential/lock context.
- Recommended remediation: Migrate to `Modal`/a canonical drawer with focus trap, labelled title/description, Escape policy, and focus restoration.
- Tests required: Testing Library keyboard tests plus browser axe/focus-order tests.
- Dependencies: None.
- Acceptance criteria: No production `role=dialog` implementation exists outside canonical primitives without an approved exception test.

## Design-System Conformance Matrix

| Component/pattern | Existing implementations | Canonical version | Drift | Consolidation |
|---|---|---|---|---|
| Modal/confirmation | `@wardenx/ui` Modal and ConfirmDialog; local MAC/screen-lock overlays | Shared focus-trapped Modal/ceremony | Two bespoke overlays | UI-002 |
| Work queue/table | Many module-local inline-style tables/worklists | Shared work-queue patterns/tokens | Behavior/state APIs vary | Extract only repeated behavior: loading, empty, selection, pagination, keyboard row |
| System states | Shared 404/403/500/offline/maintenance/session states | `CenteredStatusLayout` | Matched frame | Preserve and test transitions |
| Permission guard | Shell route guard + required permission registry | Shell guard | Structurally consistent | Add reason/recovery E2E |
| Long-running job | Per-domain status fields/worklists | None complete | No common progress/retry/resume | Implement missing job-detail pattern |
| Integration availability | Ad hoc error strings and 503 handling | None | Actions can remain available while backend adapter is unbound | Capability banner/control pattern |
| Forms/errors | Module-local labels, inline errors, toasts | Tokens and some shared fields | Error summary/focus/unsaved behavior inconsistent | Standard form state contract |
| Navigation | Registry and shell | App-specific shell | Structural route parity only | Add navigation reachability/context-preservation report |

## Information Architecture

- The clinical and revenue route taxonomy is domain-coherent, but the surface is very large: 244 staff routes require role-based navigation pruning and reliable search/context return.
- Critical provider readiness and job recovery are system concepts spread across billing, quality, reporting, and platform screens. They need shared destinations, not repeated opaque 503 messages.
- Patient context is encoded consistently in many routes, but cross-module return location and refresh preservation need browser tests.

## Accessibility Baseline

Positive: semantic linting, 349 explicit accessibility-label/table/live-region patterns, canonical focus-trapped modal, keyboard row handlers, and matched system states. Gaps: no Playwright/Cypress/axe suite, no automated zoom/reflow evidence, two identified dialog exceptions, and no evidence for all loading/status announcements.

## Responsive and Performance UX

All Vite builds pass. Staff routes are broadly lazy-loaded. Portal and admin builds emit one main JS chunk each (289 kB and 305 kB raw), and all SPAs emit source maps. Establish route-level budgets and test low-bandwidth/offline transitions before claiming a smooth field experience.

## Consolidation Plan

1. Finish P0 workflows before visual polish.
2. Add capability, background-job, upload-progress, and form-state canonical patterns.
3. Migrate dialog exceptions.
4. Map and test launch-critical frames/states across desktop/mobile/zoom/keyboard.
5. Expand consolidation only where repeated behavior is real; avoid a broad visual rewrite.
