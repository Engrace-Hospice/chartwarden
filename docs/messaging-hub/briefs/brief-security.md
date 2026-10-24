# Brief: security architect, 15 decisions on sessions, officers, partner access and headers

**Audience:** the security architect (SEC) · **Needs from you:** 15 short answers (yes / no / modify) · **Blocks:** acceptance of ADR-0083 and ADR-0084 (session policy and "the security officer"), the security concurrence on ADR-0085 (E5), the partner-share hardening in ADR-0096, the family-contact design in ADR-0099, and the browser-microphone rules in ADR-0094; the app-lock work (WP 5.5, not started).

> **Status (2026-10-23):** session and device controls (ADR-0083) and workforce offboarding (ADR-0084) are built and always on, because a security control has no tenant switch. They use the **least permissive** interpretation that meets the work-package test and say so; none of it is a security decision. Everything marked "recommended default" is an engineering proposal. The decision sheet lists only "app-lock and device policy (5.5, SEC)" in section F; this brief extends it. Index: [`README.md`](./README.md).

**How to answer:** tick one box per item. "Yes" accepts the recommended default exactly as worded; "Modify" accepts it with your change; "No" becomes a work item.

---

## A. Who is "the security officer" (ADR-0083, ADR-0084)

### SE-1. One definition of the officer role, for both sessions and offboarding (ADR-0083 "Open questions" 1; ADR-0084 "Open human decisions" 5)

**Plain language.** Two powers exist: `messaging.sessions.manage` (list and end another person's login sessions) and `messaging.offboarding.manage` (run the leaver steps). Today only the two full-access admin roles hold them, so every administrator is "the security officer". ADR-0084 asks that both powers be decided together.

- **Recommended default:** create one **named security-officer role per organisation** that holds both keys; ordinary admins no longer do. Until the role exists, the two admin roles stay the officers (today's behaviour).
- **Consequence:** a role-and-grant migration and a new "reported to" setting are needed (a follow-up change; the migration number is taken from `main` when built). Other officer-type permissions (export, partner share, analytics) go to `compliance_officer`, `administrator` and `org_admin`; this brief does not ask you to change those but you may.

**Stays blocked:** the role and the "reported to" notice. **Unblocks:** that follow-up change; removes SE-1 from ADR-0083's open list.

Answer: [ ] yes, new role  [ ] no, keep the two admin roles  [ ] modify: ____________  Name / date: ____________

### SE-2. A second person for the officer's actions (ADR-0083 open 1; ADR-0084 decisions 1 and 5; the clinical question is CL-6)

- **Recommended default:** no second approver. Revoking a session and running offboarding each need the officer's fresh second factor and are fully recorded. Instead, **every offboarding run is reported to a second named person** after the fact.
- **Consequence:** an urgent access cut is not delayed; oversight is after the event. If you want a mandatory approver, state whether it applies to a revoke of a clinician mid-shift, to the whole offboarding run, or both.

Answer: [ ] default  [ ] require approver for: ____________  Name / date: ____________

---

## B. Session and device policy (ADR-0083; WP 5.5)

### SE-3. Revoking a clinician who has an open urgent request (ADR-0083 open 2)

- **Today:** the revoke is silent about it.
- **Recommended default:** warn the officer before the revoke when the person has an open urgent or unacknowledged escalated request, and notify a supervisor after. (A revoke never blocks.)
- **Consequence:** a small change on the officer screen; no migration.

Answer: [ ] yes  [ ] no  [ ] modify: ____________  Name / date: ____________

### SE-4. App lock (ADR-0083 open 3; "Conservative defaults"; UI spec 5.5)

**Plain language.** App lock is a device PIN or fingerprint after the screen has been idle. It is **not built**; the work waits for you.

- **Recommended default (to confirm or replace):** the organisation sets the **maximum** idle time and can only tighten it; the unlock factor is the device PIN or biometric; the lock screen shows no patient information; you state the maximum idle minutes (not chosen).
- **Consequence:** until decided, a phone left unlocked and signed in stays usable for the full session.

**Stays blocked:** the app-lock build and its tenant setting (WP 5.5 remainder). **Unblocks:** that build; native biometric lock also depends on the separate mobile-app decision (ADR-0072).

Answer: [ ] default  [ ] maximum idle ___ minutes, factor ____________ , lock screen shows ____________  Name / date: ____________

### SE-5. Sign-out everywhere, user notice, account suspension, and expiring the push address on ordinary sign-out (ADR-0083 open 4; "Conservative defaults" list)

Four related items, each currently **not built**:

| Item | Recommended default | Consequence |
|---|---|---|
| "Sign out everywhere else" (bulk revoke) | not offered to the officer as "remote lockout" yet | A person must be revoked session by session |
| A notice to the revoked user | no notice | The user finds out when their next request fails |
| Should the officer's revoke also suspend the account | no, sessions only | The person can sign in again unless the account is deactivated separately |
| Should ordinary sign-out or idle timeout also expire the device's push address | yes, as a follow-up sweep (one query) | Today only an explicit revoke does; after a plain sign-out the device can still receive alerts until removed or until it fails delivery |

**Stays blocked:** the follow-up sweep and any bulk revoke. **Unblocks:** them; the linking column already exists (migration 1130).

Answer: bulk [ ] no [ ] yes · notice [ ] no [ ] yes · suspend [ ] no [ ] yes · sweep [ ] yes [ ] no  ·  modify: ____________  Name / date: ____________

### SE-6. Optional hardening listed in the ADR (ADR-0083 "Known ceilings", Not hardened)

Two gaps: (1) a person can end **their own other** sessions without a fresh second factor (so a hijacked session can sign its owner out everywhere); (2) the own-session routes do not reject portal or auditor sessions (they just return an empty list).

- **Recommended default:** (1) require a fresh second factor to end another of your own sessions; (2) reject non-staff sessions with the uniform not-found.
- **Consequence:** one more step for users who revoke a lost device; no migration.

Answer: (1) [ ] yes [ ] no  (2) [ ] yes [ ] no  Name / date: ____________

### SE-7. Prompt after a deactivation instead of an automatic run (ADR-0084 decision 4)

- **Today:** access cuts (memberships, sockets, tasks, handoffs) are automatic on deactivation; the rest (moving urgent requests, sessions, endpoints) is officer-initiated.
- **Recommended default:** stay officer-initiated, but when a user is deactivated, send an in-app notice to holders of `messaging.offboarding.manage`: "run offboarding for this user".
- **Consequence:** closes the "nobody remembered" gap without an unattended run; a person must still act, so a leaver's requests wait until they do.

Answer: [ ] yes  [ ] no, run automatically  [ ] modify: ____________  Name / date: ____________

---

## C. Reading another thread (ADR-0085)

### SE-8. Security concurrence on the thread-read grant (ADR-0085 Q1; decision 11 and 12; sheet row E5)

**Plain language.** The compliance question is whether the principle is acceptable (CO-1); yours is whether the mechanism is safe. As designed: the grant is a separate narrow check, not a change to the channel-view rule used in 40-plus places; expiry is judged on the database clock; the Part 2 check is repeated at every read; it cannot read attachments or write; the grant is a table with insert and revoke only; if the check cannot be read, the answer is "deny"; the flag `messaging.thread_access_grant` is absent (= off) until built.

- **Recommended default:** concur.
- **Consequence:** with your concurrence plus CO-1 and CL-5, slice G2 can be built; the three of you hold the E5 owners' roles. Without it, off-team on-call staff stay skipped.

**Unblocks:** G2 (grant wiring) and G3 (web).

Answer: [ ] concur  [ ] concur with changes: ____________  [ ] do not concur  Name / date: ____________

---

## D. Outside partners (ADR-0096)

### SE-9. Is a spoken 8-digit code enough for a partner? (ADR-0096 open 4; D5; limits b and l)

- **Recommended default:** yes for a first, flag-off release: invitation link plus an 8-digit code given by phone; 5 wrong tries lock the share; the session dies after 30 idle minutes or 12 hours.
- **Cost, stated plainly:** a code is weaker than an authenticator app; a leaked database row could be guessed offline (about 100 million guesses); a stolen bearer works from anywhere until it expires.
- **Alternative:** require the partner to enrol an authenticator app or passkey before reading.

Answer: [ ] code is enough  [ ] require authenticator / passkey  [ ] modify: ____________  Name / date: ____________

### SE-10. Where the partner's session token lives (ADR-0096 open 8; D21)

- **Recommended default:** in the page's memory only, sent as an `Authorization` header (not ambient, so no CSRF defence is needed). **Cost:** a reload, a crash or closing the tab ends the session, and because the link works once, staff must **reissue** an invitation.
- **Alternative:** a secure, same-site cookie scoped to the partner path, which needs its own request-forgery defence and a second revocation path.

Answer: [ ] memory-only bearer  [ ] cookie design  Name / date: ____________

### SE-11. Browser headers for `/partner/*` at the web server (ADR-0096 open 9; D23)

- **Today:** the partner page and every partner request set "do not send referrer" and "do not cache" themselves, and the API sets them on every partner response. The static page itself keeps the usual web-server headers; no nginx change was made.
- **Recommended default:** also add `Referrer-Policy: no-referrer` and `Cache-Control: no-store` for the `/partner/` location at nginx, so the page does not depend on its own code for them.
- **Consequence:** a deploy-file change (`deploy/production/TENANT_EDGE.md` and the nginx config); the page keeps working without it.
- **Also asked:** concurrence that the partner page stays inside the staff web app (D19) rather than a new app.

Answer: headers [ ] add [ ] leave  ·  hosting [ ] concur [ ] separate app  Name / date: ____________

### SE-12. The trusted-proxy list in every deployment (ADR-0096 D17; ADR-0099 open 6)

- **Today:** partner access (and the planned family link) works only when `TRUSTED_PROXY_CIDRS` holds a valid list outside development and test; with a missing or invalid list the partner routes are not mounted and creating a share answers 503. A valid list that includes a hop an attacker controls is still the operator's responsibility; only `/0` is refused.
- **Recommended default:** confirm the real proxy hops for each environment before any tenant uses partners, and record them in the deploy notes.

Answer: [ ] confirmed, hops: ____________  [ ] not yet  Name / date: ____________

---

## E. Family contact link (ADR-0099; nothing built)

### SE-13. Code length, secret pepper, abuse limits, shared code (ADR-0099 Q6; D3, D8)

- **Recommended default:** 8-digit code plus a per-invitation secret ("pepper") kept outside the table, so a stolen row is harder to guess; no authenticator (the point is "no app"); limits: 5 code tries per invitation, 10 messages an hour and 40 a day per contact, 200 messages per thread before staff reply, 25 live invitations per day per patient care team and 10 per creator; reuse the partner session code where sensible rather than copy it.
- **Consequence:** the pepper reduces, but does not remove, the offline-guess risk (ADR-0099 limit b); all numbers are defaults, not agreed values.

**Stays blocked:** slices S1 and S2. **Unblocks:** them (with PV-1 to PV-3).

Answer: [ ] default  [ ] code length ___ , limits: ____________  [ ] share session code with partner share  [ ] copy  Name / date: ____________

---

## F. Microphone and export (ADR-0094, ADR-0089)

### SE-14. Microphone permission, media sources and real phones (ADR-0094 Q6; section 5)

- **Recommended default:** the page allows the microphone for itself only (`Permissions-Policy: microphone=(self)`), the content-security policy allows the short-lived storage links as a media source, and someone tests recording on the iPhone and Android browsers the agency supports (an interrupted recording is treated as discarded, never as sent). The current header configuration was **not** checked when the ADR was written.
- **Consequence:** voice recording could silently fail on iPhones if backgrounding stops capture.

**Unblocks (with CL-12 and PV-4):** the first voice-note slice.

Answer: [ ] default, headers checked on (date) ________  [ ] modify: ____________  Name / date: ____________

### SE-15. One human with two admin accounts can approve their own export (ADR-0089 limit h; D1)

- **Today:** the database makes requester and approver different **accounts**; it cannot know two accounts are one person.
- **Recommended default:** accept, because both are named in the audit trail and every approver is alerted; the compliance officer owns the approver list (CO-5).
- **Alternative:** require the approver to hold a role the requester does not, or to be in a separate tenant-administered group.

Answer: [ ] accept  [ ] require separate roles  [ ] modify: ____________  Name / date: ____________

---

*Not in this brief:* compliance positions (CO), vendor agreements (PV), clinical choices (CL).
