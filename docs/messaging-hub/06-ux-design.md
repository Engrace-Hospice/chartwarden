# 06 — UX Design

> Part of the [Messaging Hub plan](./README.md). **Match the redesign kit**: shared `wx-*` list chrome (`packages/ui/src/web/styles/list-chrome.css`),
> flat rail/drawer pattern, the mockup blue palette. No new visual identity and no old-style inline UIs. Layout rules live in
> `docs/design/CHARTWARDEN_UI_LAYOUT_PATTERNS.md`; add any new screen to the UI screen index (`bun run docs:ui` / `arch:ui`).

## 1. Layout — three-panel workspace

```
┌ Care Communications ───────────────────────────────────────────────────────────────────────┐
│ [+ New]  🔍 search                                                                           │
├──────────────┬───────────────────────────────────────────────┬──────────────────────────────┤
│ INBOX        │ CONVERSATION                                  │ PATIENT CONTEXT (collapsible)│
│ All·Unread·  │ Margaret Brandt · Care Team   RN·SW·CH·MD     │ Margaret Brandt              │
│ Urgent·Ment. │ ┌ Urgent · awaiting acknowledgment ─────────┐ │ Hospice · Active             │
│ Direct·Teams │ │ SBAR (RN) → On-call RN · due 14:20        │ │ Care team: RN · MD · SW · CH │
│ ───────────  │ │ [Acknowledge] [Reassign]                  │ │ Quick access                 │
│ On-call RN ● │ └───────────────────────────────────────────┘ │  Care plan · Medications ·   │
│  Pain esc.   │ Rita, RN: Family requested a call             │  Orders · Visits · Tasks     │
│ Margaret CT  │ You: I'll follow up this afternoon  ✓ read    │ Open tasks (2)  Linked items │
│ IDG Team     │ ─────────────────────────────────────────────│                              │
│              │ [B I • 1. @ 📎 SBAR ⚑urgent] Message…  [Send] │                              │
└──────────────┴───────────────────────────────────────────────┴──────────────────────────────┘
```
- **≥ 1280 px:** three columns. **768–1279 px:** inbox + conversation; context is a right slide-over. **< 768 px:** one pane at a time with a back
  affordance; composer docked; context and thread as full-height sheets.
- Inbox rows show: avatar/kind icon, title, last-preview (sanitised), time, unread badge, **urgency chip**, **"awaiting ack"** state. Pinned/urgent rise.
- Safety queue (supervisors) and Handoffs are inbox filters, not separate apps, so staff keep one mental model.

## 2. Message hierarchy
Day separators; grouped consecutive messages; own messages right-aligned; system events (membership, task created, promotion, escalation step)
as muted inline rows; **urgent/ack cards visually distinct** (icon + text + border, never colour alone). Edited indicator opens revision list
(permitted roles). Tombstone: "Message deleted by author."; redaction: "Content redacted — see compliance record" (no body).

## 3. Composer
Compact by default: rich text (bold/italic/list/link), `@` mention picker (staff directory is minimum-necessary), `#`/`+` clinical link picker
(opens a scoped search per source module, filtered by permission), attachment button (+ camera on mobile), template menu (SBAR, saved replies),
**urgency toggle** (opens the Urgent flow, never a hidden default), schedule send, and draft status ("Saved" / "Saved on this device only").
Enter sends, Shift+Enter newline, Esc closes pickers, `Ctrl/⌘+K` global jump, `Ctrl/⌘+F` in-conversation search.

## 4. Required states (every list/panel)
| State | Behaviour |
|---|---|
| Loading | Skeleton rows; `aria-busy` |
| Empty thread | "No messages yet" — **only** when the server confirmed an empty, accessible thread |
| Load failed | Error with retry and a correlation id; never rendered as empty |
| Forbidden / access ended | "You no longer have access to this conversation"; no title/preview leak |
| Offline | Banner; composer enabled; messages show **Not sent** until the server confirms |
| Degraded realtime | Subtle banner "Live updates paused — refreshing every N s" |
| Urgent pending | Persistent card + inbox badge until acknowledged/resolved |

## 5. Accessibility (WCAG 2.2 AA)
Landmark regions per panel; logical focus order inbox → conversation → composer → context; `aria-live=polite` for new messages and
`assertive` only for urgent arrival; every icon-only control has an accessible name; timestamps relative + absolute (sr-only);
visible focus; 4.5:1 contrast; supports 200 % text and reduced motion; touch targets ≥ 44 px; full keyboard operation of ack/reassign/
handoff accept. Evidence: axe run + scripted keyboard walk + screen-reader script recorded per phase.

## 6. Component/file hygiene
`conversation-thread.tsx` (852 lines) and `staff-messaging.css` (978 lines) exceed the 800-line ceiling; split while moving to the
three-panel shell: `InboxPane`, `ConversationPane`, `Composer`, `MessageList`, `PatientContextPanel`, `AckCard`, `HandoffSheet`,
`TaskDrawer`, plus a `useMessagingRealtime` hook. Keep PHI-bearing state teardown behaviour (the existing sign-out/reset test coverage in
`staff-messaging.dom.test.tsx` must survive the refactor). Shared chrome goes in `packages/ui` list-chrome, not the module CSS.
