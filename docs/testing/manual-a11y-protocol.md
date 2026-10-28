# Manual accessibility protocol (WCAG 2.2 AA)

The automated suite (`e2e/specs/axe-route-walk.spec.ts`, the per-workflow `expectNoAxeViolations`
scans, and `viewport-matrix.spec.ts`) catches the structural class of defect: missing names, landmark and
heading order, contrast, document-level reflow. It cannot judge keyboard operability, focus order,
zoom behaviour or what a screen reader actually announces. This protocol covers that half. Coverage
status of the automated half: [`audit/e2e-coverage/E2E_COVERAGE.md`](../../audit/e2e-coverage/E2E_COVERAGE.md)
(tracked by issue #852, finding CW-QA-0008).

## When to run it

- Before each release that changes a high-risk clinical or billing form, the app shell, or a shared
  `packages/ui` component.
- At least once per quarter over the sample below, even when nothing changed.
- Run against the seeded demo stack (`bun run db:reset && bun run dev`), signed in as the persona that
  owns the screen (credentials in the gitignored `CREDENTIALS.local.md`). Never use real PHI.

## Screen sample (minimum)

| # | Screen | Why |
|---|---|---|
| 1 | Sign-in, organization select, step-up | Entry; every user passes it |
| 2 | Patients census and a patient chart (tabs) | Densest navigation |
| 3 | Encounter compose and sign (`/patients/:id/encounters/:id/compose`) | Long clinical form, step-up |
| 4 | eMAR administration modal (`/patients/:id/emar`) | Medication safety |
| 5 | HOPE timepoint form | Regulated assessment form |
| 6 | Consent capture (`/patients/:id/consents/new`) | Legal artefact |
| 7 | Billing claim detail and work queue | Dense tables, status |
| 8 | Messaging workspace (`/messaging`) | Live regions, split view |
| 9 | Portal sign-in and funeral/collaborator redemption (apps/portal) | Public, family-facing |

## 1. Keyboard and focus order

Tools: keyboard only (unplug or ignore the pointer). Browser: Chrome and Safari.

| Check | WCAG 2.2 | Pass when |
|---|---|---|
| Every control reachable and operable with Tab, Shift+Tab, Enter, Space, arrows | 2.1.1 Keyboard | No mouse-only action exists |
| No keyboard trap; modals release focus with Escape or a visible close | 2.1.2 No Keyboard Trap | Focus can always leave |
| Tab order follows visual and reading order | 2.4.3 Focus Order | No jumps to unrelated regions |
| Focus indicator visible on every focusable element | 2.4.7 Focus Visible | Indicator clearly seen on each stop |
| Focused element is not hidden by sticky header, drawer or toast | 2.4.11 Focus Not Obscured (Minimum) | Focused item at least partly visible |
| Skip link or landmark navigation reaches main content | 2.4.1 Bypass Blocks | First Tab offers it, or landmarks work |
| Opening a modal moves focus in; closing returns it to the trigger | 2.4.3, 3.2.1 | Focus returns to the invoking control |
| Focus moving to a field does not change context | 3.2.1 On Focus | No navigation or submit on focus |
| Dragging has a keyboard or single-pointer alternative | 2.5.7 Dragging Movements | Every drag action has one |
| Targets at least 24 by 24 CSS px (or spacing exception) | 2.5.8 Target Size (Minimum) | Measured with devtools |
| Help or contact mechanism is in a consistent place | 3.2.6 Consistent Help | Same relative location per screen |
| Re-entering already supplied data is not demanded | 3.3.7 Redundant Entry | Multi-step forms reuse earlier input |
| Authentication does not rely on a cognitive test alone | 3.3.8 Accessible Authentication (Minimum) | Paste allowed; passkey or manager works |

## 2. Zoom and reflow

Chrome, zoom via Cmd/Ctrl +. Viewport 1280 by 1024 CSS px at 100% as the baseline.

| Check | WCAG 2.2 | Pass when |
|---|---|---|
| 200% zoom: all content and functions available | 1.4.4 Resize Text | Nothing clipped, overlapped or lost |
| 400% zoom (equals a 320 px wide viewport): no two-dimensional scrolling for reading content | 1.4.10 Reflow | Only data tables or maps may scroll within their own container |
| Browser text-spacing override (line 1.5, paragraph 2, letter 0.12, word 0.16 em) loses nothing | 1.4.12 Text Spacing | No clipped or overlapping text |
| Hover or focus content is dismissible, hoverable, persistent | 1.4.13 Content on Hover or Focus | Tooltip survives pointer move, Esc closes |
| Orientation not locked | 1.3.4 Orientation | Works portrait and landscape |
| Content reachable at 400% with sticky chrome | 2.4.11 | Sticky header does not eat the viewport |

The six-width automated smoke (`bun run test:e2e:viewports`) checks only document-level horizontal scroll
and axe at each width; the checks above are the human judgement on top of it.

## 3. Screen reader

Pairings: VoiceOver with Safari (macOS, Cmd+F5), NVDA with Firefox or Chrome (Windows), and VoiceOver
with Safari on iOS for the portal. Record versions in the results.

| Check | WCAG 2.2 | Pass when |
|---|---|---|
| Page has a meaningful title and one h1; headings nest logically | 2.4.2, 1.3.1 | Rotor or headings list reads as an outline |
| Landmarks (banner, nav, main, complementary) exist and are named when repeated | 1.3.1, 4.1.2 | Landmarks list is accurate |
| Every control announces name, role, and state (expanded, selected, pressed, invalid) | 4.1.2 Name, Role, Value | No "button" or "link" without a name |
| Form fields announce label, required, and hint; errors announced on submit and tied to the field | 3.3.1, 3.3.2, 1.3.1 | Error text read with the field |
| Data tables announce headers per cell; sortable state is announced | 1.3.1 | Navigate cell by cell, headers read |
| Async results, toasts, and message arrivals are announced without stealing focus | 4.1.3 Status Messages | Live region speaks once |
| Icons and status pills do not rely on colour alone | 1.4.1 Use of Color | Text or icon conveys state |
| Images carry accurate text alternatives or are hidden when decorative | 1.1.1 | No file names read |
| Link purpose is clear from its text or context | 2.4.4 | No bare "click here" |
| Language of the page set (and of foreign-language passages) | 3.1.1, 3.1.2 | Voice pronounces correctly |
| Clinical safety text (allergy, high-alert, step-up refusal) is read, in order, before the action it guards | 1.3.2 Meaningful Sequence | Heard before the confirm button |

## 4. Recording results

Copy the template into a dated file under `audit/manual-a11y/` (create it on first use) or paste it into
the release issue. One block per screen per pairing. Any Fail becomes a GitHub issue labelled
`accessibility` and links back to the block.

```markdown
## Manual a11y run YYYY-MM-DD

- Build / commit:
- Tester:
- Environment (browser + version, OS, AT + version):
- Persona / account used:

### Screen: <registry id, path>

| Area | WCAG SC | Result (Pass / Fail / N/A) | Evidence (note, screenshot, recording) | Issue # |
|---|---|---|---|---|
| Keyboard operable | 2.1.1 | | | |
| No keyboard trap | 2.1.2 | | | |
| Focus order | 2.4.3 | | | |
| Focus visible / not obscured | 2.4.7, 2.4.11 | | | |
| 200% zoom | 1.4.4 | | | |
| 400% reflow | 1.4.10 | | | |
| Text spacing | 1.4.12 | | | |
| Name, role, value | 4.1.2 | | | |
| Form labels and errors | 3.3.1, 3.3.2 | | | |
| Status messages | 4.1.3 | | | |
| Target size | 2.5.8 | | | |
| Accessible authentication | 3.3.8 | | | |

Sign-off: <name>, <date>. Open Fails: <count>.
```

## Not automated and not covered here

- The admin console (`apps/admin`) beyond its pre-auth screens needs a `platform_ops` login the demo seed
  does not provide to the browser suite; run sections 1 to 3 on it by hand.
- Portal session-gated screens require a magic-link mailbox; run them by hand.
- WCAG 2.2 success criteria not listed above are either covered by axe (2A/AA rule set used by the
  suite) or not applicable to this product (audio, video, time-based media). Re-evaluate if media is added.
