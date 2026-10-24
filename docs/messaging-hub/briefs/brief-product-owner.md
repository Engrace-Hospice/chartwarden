# Brief: product owner, 12 decisions on switches, defaults, order of work and names

**Audience:** the product owner (also the interim M19 owner; the M19 questions are in [`brief-m19-owner-followup.md`](./brief-m19-owner-followup.md)) · **Needs from you:** 12 short answers (yes / no / modify) · **Blocks:** which messaging features any tenant may switch on, the order of the gated builds, and the operations questions nobody else owns yet.

> **Status (2026-10-23):** most features below are built **flag-off**; a flag that is absent means off. Nothing here was decided by you before except the items already recorded in [`../11-decision-sheet.md`](../11-decision-sheet.md) section E (E1, E2, E4, E5, 2026-10-19). Every default is a build-team proposal. The go-live precondition (a named watcher for the unacknowledged queue, sheet row A1) is not repeated. Operations has no named owner in these documents, so PO-11 routes its questions to you. Index: [`README.md`](./README.md).

**How to answer:** tick one box per item. "Yes" accepts the recommended default exactly as worded; "Modify" accepts it with your change.

---

### PO-1. Which switches may a tenant turn on, and in what order (decision-sheet rows A1 to A4 extended)

| Switch (tenant flag) | State today | Recommended default |
|---|---|---|
| `messaging.afterhours_triage` (with `messaging.role_send`) | built (S1 to S5), off | stays off until a router is bound and S6 passes (M19-1) |
| `messaging.thread_access_grant` | does not exist; table built, unwired | do not create until CO-1, SE-8, CL-5 are answered |
| `messaging.export` | built, off | on only after CO-5 to CO-9 |
| `messaging.smart_inbox` | built, off | on after CL-8, CL-9 |
| `messaging.response_analytics` | built, off | on only after CO-10 to CO-12 |
| `messaging.external_partners` | built, off | on only after CO-18, CL-13, PV-11, SE-9 to SE-12 |
| `messaging.ack_broadcast` | built, off | on after CO-15, CO-16, CL-15 |
| `messaging.death_board` | built, off | on after CL-16, CL-17, CO-17 and **before** the first death you want coordinated (no backfill; see PO-12) |
| `messaging.family_messaging`, `messaging.dictation`, `messaging.ai.enabled`, `messaging.external_partner_replies` | do not exist (designs only; names are proposals) | not created |

- **Consequence of the default:** nothing reaches a real tenant until its named owners have answered. The demo seed lists `messaging.smart_inbox` for demonstration tenants only and does **not** switch on analytics. Who may set flags per tenant (the tenant or the platform owner) is still open as sheet row A3.

Answer: [ ] yes  [ ] no  [ ] modify order / gates: ____________  Name / date: ____________

### PO-2. May a sender opt out of the after-hours triage request? (ADR-0082 "Implementation notes", Who asks; "Still blocked or open", last bullet)

- **Today:** while the flag is on, **every** role send to the on-call also asks for a triage call; there is no per-send opt-out.
- **Recommended default:** keep it that way (a message to the on-call RN after hours should be tracked).
- **Consequence:** a clinician cannot simply message the on-call RN without opening a call. If you want an opt-out, it is a small change to the two send files and needs a clinical-lead nod (CL-3).

Answer: [ ] no opt-out  [ ] add opt-out  Name / date: ____________

### PO-3. Family messaging: portal first or link first, and which app serves the contact page (ADR-0099 Q8; D1; slice S5)

- **Recommended default:** the **portal stays preferred**: the staff screen offers "invite to the portal" first and "send a one-time message link" second; the contact page for the link is a minimal public page, **not** the portal app (which has accounts, password and 2FA). The app choice is marked "DECISION NEEDED" in the ADR.
- **Consequence:** a contact who later creates a portal account has the link revoked; the family thread is not merged into the care-team channel. Verified for the build: how much of the portal messaging path exists was **not** checked (ADR-0099 limit f); if it is incomplete, the order may change.

**Stays blocked:** slice S5 (contact page) and part of S4. **Unblocks:** S4, S5 together with PV-1 to PV-3.

Answer: [ ] portal first, minimal public page  [ ] link first  [ ] page in portal app  Name / date: ____________

### PO-4. Partner page: where it lives, preview, long conversations (ADR-0096 open 9 (hosting part), 10, 11)

- **Recommended default:** the page stays inside the staff web app as a plain route (`/partner/share`), not a new app (D19); the staff preview is a **synthetic example** (two fixed example messages), not the real filtered output (D22); a "newest messages" read for long conversations is a follow-up (today the page shows the first 200 messages since the share).
- **Consequence:** staff cannot preview a particular message; a busy conversation can exceed 200 messages and the partner cannot reach the newest ones. Header details are asked of security in SE-11.

Answer: [ ] hosting yes  [ ] separate app  ·  preview [ ] synthetic enough [ ] must show real  ·  tail read [ ] schedule [ ] later  Name / date: ____________

### PO-5. Partner replies: build or not, and priority (ADR-0096 D25; open 2, 8)

- **Recommended default:** do **not** build yet. Replies are a design only (flag `messaging.external_partner_replies`, new author kind, migration 1203 reserved and unused, a split enum migration). Four sign-offs are open (CL-14, CO-19, plus the schema change across every message consumer).
- **Consequence:** a partner can read but never answer; staff continue by phone or email outside the system.

Answer: [ ] not now  [ ] build after CL-14 and CO-19 are yes  Name / date: ____________

### PO-6. Broadcast: reminders, late joiners, narrower audiences, a title (ADR-0097 "Not done / open" 2 and 3; D9)

- **Recommended default:** no reminders (the screen shows a "Past deadline" marker and nothing chases anyone); no late-joiner action; no role or location audiences; the list identifies an announcement by its sent time, not a title; no export.
- **Consequence:** an author must watch the list. Reminders, when built, must use one fixed generic text and the existing notification rules.

Answer: [ ] none of these now  [ ] priority order: ____________  Name / date: ____________

### PO-7. Smart inbox: where a row opens, and naming (ADR-0091 "Not decided / provisional")

- **Today:** every row opens `/messaging` because the conversation, task and handoff screens have no address that selects one item.
- **Recommended default:** accept for now; add deep links when those screens get addresses.
- **Consequence:** one extra click from the inbox row to the item.

Answer: [ ] accept  [ ] schedule deep links  Name / date: ____________

### PO-8. Analytics: platform step, a stricter per-tenant floor, team and shift views, aggregate export (ADR-0092 "Not done / open")

- **Recommended default:** the platform admin step that sets `messaging.response_analytics` for a real tenant is done only after CO-10 to CO-12; no per-tenant stricter floor yet (it can only be tightened later); team and shift breakdowns and any CSV or PDF export of the aggregate are **not scheduled** (an export is a new egress surface needing its own decision).
- **Consequence:** only organisation-wide and discipline figures, in whole completed days, appear.

Answer: [ ] yes  [ ] schedule: ____________  Name / date: ____________

### PO-9. AI summaries: price, caps and limits (ADR-0095 open 8; decision 7)

- **Recommended default:** starting guesses, unmeasured: 10 summaries and 20 drafts per user per hour; 3 summaries per channel per 10 minutes (unchanged thread returns the user's in-memory result); about 50 messages or 14 days per summary; 600 output tokens for a summary and 300 for a draft; an 8-second timeout; the tenant's existing soft and hard token caps apply. No price is set.
- **Consequence:** every click costs money until measured; this is not buildable until PV-6 and CL-10 are answered.

Answer: [ ] defaults  [ ] modify limits / price: ____________  Name / date: ____________

### PO-10. Voice notes before dictation (ADR-0094 "Not done" 1 and 2)

- **Recommended default:** build **voice notes only** (attachment allow-list, size limit, recorder, typed-text rule, tests, a check forbidding browser speech recognition) once CL-12, PV-4, SE-14 and PO-11 are answered; dictation stays unbuilt until a business-associate route exists (PV-5). Transcripts of already-sent notes for readers are a separate feature needing their own decision.
- **Consequence:** field nurses can record but not dictate; OS keyboard dictation on a phone is outside the product's control.

Answer: [ ] voice notes first  [ ] wait for dictation  Name / date: ____________

### PO-11. Operations questions with no named owner (ADR-0094 Q5; ADR-0099 Q7)

Please answer or name the operations owner.

1. Which virus scanner runs in production? (The built-in scanner only checks file type and never looks for malware in audio.)
2. May the setting that lets the system destroy attachment objects (`messaging.retention_attachment_destruction`) be turned on? With it off, audio and other attachments are never destroyed.
3. The agency's 24-hour number and bereavement support number must exist as required tenant settings before any family invitation can be created; who supplies them, and **who watches the family message lane after hours**?

- **Recommended default:** name the owner and answer 1 to 3 before the voice and family slices start.
- **Consequence:** voice notes would ship scanned only by a type check; family messaging cannot start without the numbers.

Answer: owner: ____________  1: ____________  2: [ ] yes [ ] no  3: ____________  Name / date: ____________

### PO-12. Deaths that happen while the death-board flag is off (ADR-0098 "Hazards"; "Known limits")

- **Recommended default:** accept: no board is made for a death while the flag is off, and switching it on later does **not** create boards for earlier deaths. Operators must switch it on before they need it. A backfill is not built.
- **Alternative:** schedule a backfill for deaths recorded while the flag was off (no slice or migration number exists).
- **Consequence:** a tenant that enables the flag late must coordinate earlier deaths by hand.

Answer: [ ] accept  [ ] schedule backfill  Name / date: ____________

---

*Related:* naming and wording that need a clinician (CL), the router questions (M19 follow-up), and everything that needs a lawyer (PV).
