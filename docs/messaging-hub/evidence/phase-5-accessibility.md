# Phase 5 evidence: responsive, touch and WCAG 2.2 AA (WP 5.4)

Status: automated jsdom axe + keyboard gate executed; Playwright spec written, **not executed** (no live stack in this session); screen-reader and device sign-off **not done** (templates below, unsigned).

## 1. Method

| Layer | Tool | Where | Run in this work item |
| --- | --- | --- | --- |
| Axe over the real `StaffMessaging` in six states, focus order, Escape | vitest + jsdom + axe-core | `apps/web/src/modules/36-messaging/phase5-a11y.gate.dom.test.tsx` | Yes, 7/7 pass |
| Axe at 360 / 768 / 1280 px, target-size table, 200% zoom, 320 px reflow, offline to online | Playwright + @axe-core/playwright | `e2e/specs/messaging-responsive.spec.ts` | **No** (needs the Docker stack and seeded demo data) |
| Touch-target sizes of the CSS | static reading of the changed rules | section 3 | Static only |
| VoiceOver (macOS/iOS), NVDA (Windows) | human | sections 5 and 6 | **No** |

jsdom cannot compute layout, so it does not assert target size, contrast, zoom or reflow. Axe runs with `color-contrast` and `region` disabled in jsdom (no layout, no page chrome); the Playwright spec runs the full WCAG 2A/AA set including contrast via the shared `expectNoAxeViolations` helper.

## 2. Axe results obtained (jsdom, critical + serious, wcag2a/2aa/21a/21aa/22aa + best-practice)

Command: `bunx vitest run apps/web/src/modules/36-messaging/phase5-a11y.gate.dom.test.tsx` (2026-10-21).

| Test | State | Result |
| --- | --- | --- |
| A1 | Inbox (conversation list) | 0 violations |
| A2 | Open DM thread with a message | 0 violations |
| A3 | Offline (banner is an `<output>` live region) | 0 violations |
| A4 | Pending row ("Not sent", labelled "Retry sending message") | 0 violations |
| A5 | Degraded realtime ("Live updates paused", `<output>`) | 0 violations |
| A6 | Patient-context slide-over open; Escape closes; focus returns to the toggle; `aria-expanded` follows | 0 violations, behaviour passes |
| F1 | Tab order: thread header, then timeline, then composer textbox, monotone | passes |

Not covered by F1: the clinical-link chip stop. The chip's own axe case is in `clinical-link-chip.dom.test.tsx`; its position in the tab order inside a real timeline is left to the Playwright run.

## 3. Touch targets: static analysis (NOT measured)

Target: `min-height`/`min-width` of `2.75rem` (44 px at the default 16 px root) on every interactive control. Before/after, from the CSS in this change:

| Rule (file) | Before | After |
| --- | --- | --- |
| `.wx-reassign-form fieldset label` (ack-reassign.css) | 2rem | 2.75rem |
| `.wx-channel-members select` (announcements.css) | 2.25rem | 2.75rem |
| `.wx-clinical-link button` (clinical-links.css) | 1.75rem | 2.75rem |
| `.wx-attachment-open` (composer-attachments.css) | 2rem x 2rem | 2.75rem x 2.75rem |
| `.wx-draft-conflict-actions button` (draft-conflict.css) | 2rem | 2.75rem |
| `.wx-reaction-chip/.wx-reaction-add/.wx-pin-toggle`, reaction picker buttons, annotation row (message-annotations.css) | 1.5rem / 2rem | 2.75rem |
| `.wx-msg-search-input`, `.wx-msg-search-close`, date inputs (message-search.css) | 2rem / 1.75rem | 2.75rem |
| `.wx-messaging-search`, `.wx-conversation-type-tabs button` (inbox.css) | 2.5rem / 2rem | 2.75rem |
| `.wx-conversation-type-tabs button`, picker search (new-conversation.css) | 2.5rem / 2.6rem | 2.75rem |
| `.wx-messaging-context-toggle` (thread.css) | 2.25rem | 2.75rem |
| `.wx-poll-dialog input[type=text]` (polls.css) | 2.5rem | 2.75rem |
| `.wx-scheduled-edit input` (scheduled-send.css) | 2.5rem | 2.75rem |
| `.wx-template-search` (saved-replies.css) | 2.5rem | 2.75rem |
| `.wx-urgent-form fieldset label` (urgent.css) | 2rem | 2.75rem |
| `.wx-reply-context`, `.wx-thread-count/.wx-thread-reply`, thread-actions row (thread-panel.css) | 1.5rem | 2.75rem |

Known to be already compliant (unchanged): composer send/attach, patient-context close, notification-preference rows, saved-reply rows, the 767 px responsive icon buttons.

Deliberately left under 44 px because they are not controls: unread/mention count badges (`inbox.css`, 1.25-1.35rem), avatar spacers, skeleton rows, the visually hidden read-only label. The Playwright table will flag any real control this analysis missed (for example controls sized only by padding, or in components styled outside `36-messaging/*.css`).

Measured table (to be pasted from the Playwright annotation `targets` after a live run): _not available_.

Other CSS in this change: one `:focus-visible` ring (2px `--color-primary`, 2px offset) for every interactive element under `.wx-messaging-page` (messaging-layout.css); `overflow-wrap: anywhere` on the page; a `max-width: 400px` block (messaging-responsive.css) that lets the thread header and composer wrap and removes the page `min-height` so 320 px reflow does not force scrolling in two directions. The existing 1279 px slide-over and 767 px single-pane breakpoints are unchanged.

## 4. Keyboard-only script (manual, in addition to the automated K1-K7 and F1)

1. Load `/messaging`; press Tab once: skip link or first nav stop is reached, a visible 2px ring is on it.
2. Tab to the filter tabs: one Tab stop; arrows move, Home/End jump.
3. Tab to a conversation row, Enter: thread opens, focus is in the thread.
4. Tab order: thread header controls, timeline actions (Reply, reactions), composer, Send. No keyboard trap.
5. On a viewport 768-1279 px wide: activate "Patient context"; focus moves into the panel; Escape closes it; focus is back on the toggle.
6. On a viewport under 768 px: Back returns to the list with focus on the row just left.
7. Go offline (devtools): banner appears; type and Send; row shows "Not sent"; Retry is reachable by keyboard; go online, the row clears.

Signed: ______________________  Date: ____________  Build/commit: ____________

## 5. VoiceOver manual script (unsigned template)

Environment: macOS ___ / Safari ___ , or iOS ___ / Safari ___. Tester: __________ Date: __________

| # | Step | Expected | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| 1 | Rotor > Landmarks on `/messaging` | Page header and conversation regions are listed and named | | |
| 2 | Rotor > Headings | Page title, thread title in sensible order | | |
| 3 | Move to a conversation row | Name, unread count and preview are spoken once | | |
| 4 | Open a thread | "Conversation with <name>" region announced | | |
| 5 | VO through the timeline | Author, time, body, and Reply/React controls each have a name | | |
| 6 | Urgent/ack message | Priority is spoken in text, not only colour | | |
| 7 | Go offline | "You're offline" announced without moving focus | | |
| 8 | Send while offline | "Not sent" and "Retry sending message" are spoken | | |
| 9 | Realtime pause | "Live updates paused" announced | | |
| 10 | Open Patient context | Focus lands in the panel; Escape closes and focus returns | | |
| 11 | iOS: swipe through the list and thread | Every control reachable, 44 pt targets hit without mis-taps | | |

## 6. NVDA manual script (unsigned template)

Environment: NVDA ___ / Windows ___ / Firefox or Chrome ___. Tester: __________ Date: __________

| # | Step | Expected | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| 1 | D (landmarks) and H (headings) | Landmarks and headings named, no unnamed regions | | |
| 2 | Browse mode through the list | Each row announces name, unread count, preview | | |
| 3 | Enter on a row | Focus mode into the thread; region name announced | | |
| 4 | Tab through timeline and composer | Controls named; textbox labelled "Message" | | |
| 5 | Offline / online toggle | Status messages announced politely, once | | |
| 6 | "Not sent" row | Retry control announced with its name | | |
| 7 | Patient context panel | Panel announced on open; Escape closes; focus returns | | |
| 8 | 200% zoom, 320 px window | Content readable, no horizontal scroll, no lost controls | | |

## 7. Screenshots (placeholders)

Capture after a live run and attach; do not commit images without review (PHI: use seeded demo data only).

| State | 360 px | 768 px | 1280 px | File |
| --- | --- | --- | --- | --- |
| Inbox | | | | |
| Thread | | | | |
| Slide-over open | n/a | | | |
| Offline banner | | | | |
| "Not sent" row | | | | |
| 200% zoom | | | | |
| 320 px reflow | | | | |
| Focus ring on header, chip, composer | | | | |

## 8. Mobile app equivalent checklist (separate repo: `chartwarden-mobile`, React Native)

Not executed here; this repo cannot see that code. For the owner of that repo:

- [ ] Every `Pressable`/`TouchableOpacity`/icon button has `accessibilityLabel` (and `accessibilityRole="button"`, `"tab"`, `"link"` as fitting); no control is announced as "button" with no name.
- [ ] Decorative icons and avatars: `accessible={false}` / `importantForAccessibility="no"`; informative ones have a label.
- [ ] State is exposed: `accessibilityState={{ selected, disabled, expanded, busy }}` for tabs, filters, the patient-context sheet, sending rows.
- [ ] 44 x 44 pt minimum touch target (Android guideline 48 dp): use `minHeight/minWidth: 44` or `hitSlop` to reach it without changing the visual size.
- [ ] Dynamic Type / font scale at 200%: no `allowFontScaling={false}` on message text, composer or buttons; layouts use flex and wrap, no fixed heights on text containers; verify iOS "Larger Accessibility Sizes" and Android font size max.
- [ ] VoiceOver (iOS) and TalkBack (Android) walk: list, thread, composer, offline banner, "Not sent" retry, patient-context sheet, urgent/ack message.
- [ ] Live announcements: offline, reconnect, new urgent message use `AccessibilityInfo.announceForAccessibility` (iOS) / `accessibilityLiveRegion="polite"` (Android).
- [ ] Focus management: opening a sheet moves focus into it and returns on close (`AccessibilityInfo.setAccessibilityFocus`); `accessibilityViewIsModal` on sheets.
- [ ] Reduce Motion and Bold Text respected; contrast of unread/urgent colours at least 4.5:1 for text and 3:1 for icons in light and dark.
- [ ] Screen-reader and device matrix signed and dated by a human: ______________________

## 9. Open items

1. Run `e2e/specs/messaging-responsive.spec.ts` on the Docker stack; paste the target table and fix whatever it flags.
2. A human completes and signs sections 4, 5 and 6, and attaches section 7.
3. The mobile checklist in section 8 is handed to the `chartwarden-mobile` owner.
4. Colour contrast is asserted nowhere in jsdom; it is only covered by the live Playwright axe runs.
