# ADR-0074 — Lock-screen privacy: out-of-band text is composed in one render function from a fixed allowlist, and anything not minted by a sanitiser renders as the generic wording

- **Status:** **Accepted** (2026-10-18; decisions closed in the WP 4.7 blueprint). **The generic wording and the choice to name the urgency level are PROVISIONAL: no clinical-lead sign-off recorded** (brief section 9).
- **Date:** 2026-10-18
- **Phase:** Messaging Hub Phase 4 (WP 4.7, Lock-screen privacy).
- **Implements:** `docs/messaging-hub/04-phases-4-to-6.md` WP 4.7 ("Push/SMS/email templates carry no patient identifiers or PHI; deep link requires authenticated session; template tests"; acceptance: "snapshot test over every template: no name/MRN/diagnosis/free text"). Closes risk H-05 and capability NE-10 ("have (sanitiser) / prove").
- **Extends:** [ADR-0073](ADR-0073-messaging-notification-policy.md) (which makes real push and SMS delivery rows for urgent request alerts), spec section 4.7.
- **Related:** WP 4.8 (the `/n/:id` route and deep-link landing) is [ADR-0075](ADR-0075-messaging-deep-link-landing.md).
- **Numbering note:** the index still has two ADR-0069 files and a missing number between 0071 and 0073 (known red `arch:adr-docs` on main). 0074 is the next free number after ADR-0073.

## Context

Checked in the code, not assumed:

- Out-of-band content is already built by `sanitizeForOutOfBand` (allowlist: delivery id, a per-category generic line, a deep link). The dispatcher builds its input from a claim of ids and a category; no payload, no body, no template. Alert payloads and the M20 `notification_template` rows (including tenant overlays) never reach a vendor.
- The weak points were around the sanitiser: each transport composed its own subject, title and body from `short` and `deepLink` (the SMS concatenation could exceed one segment with a long base URL); `SanitizedNotification` is a plain interface, so any future caller could hand a transport a hand-built object with its own text; the link was built from an unchecked base URL and id (a base URL with a query or credentials, or a non-opaque id, went straight into a message); and the lines said "urgent clinical alert", naming the clinical nature of the work.
- There was no `/n/:id` route in the web app when this was decided (it is built in WP 4.8, [ADR-0075](ADR-0075-messaging-deep-link-landing.md)). The link is a content-free, opaque path that route gates on an authenticated session.

## Decisions

1. **One render function.** `renderOutOfBand(notification, channel)` in `packages/messaging/src/notification/sanitize.ts` is the only place a subject, title, SMS body, email text, push body or spoken line is composed. The three alert transports (Twilio SMS and voice, Postmark, web-push) call it and no longer read `short` or `deepLink`.
2. **Provenance, enforced at render time, bound to channel.** The two sanitisers register what they mint, with the channels it is valid for, in a module-private `WeakMap`: `sanitizeForOutOfBand` is valid for sms, email, push and voice; `sanitizeForEmergencyContactCall` for voice only. `renderOutOfBand` trusts an object only for a registered channel. A hand-built notification, or a spread copy with a changed `short`, renders as the generic wording with no link (and the fixed voice script on voice). It never throws and never drops the send, so a designated safety route is delivered with generic text rather than lost. The SOS emergency-contact call (a consented third party, fixed template, two allowlisted name variables) is minted by its own sanitiser and so still speaks its script on voice; handed to push, SMS or email its script (which names the agency and the clinician) renders as the generic wording instead. Every substitution calls an optional observer (`setOutOfBandFallbackObserver`) with a stable reason code (`unissued_notification` or `channel_not_bound`) and the channel only, never text or ids; the backend logs it as a warning. At boot, in production or staging, an empty or non-http(s) `WEB_APP_URL` / `BETTER_AUTH_URL` logs a warning that alerts will ship without a link.
3. **Generic wording.** Urgent: "You have a new urgent request in ChartWarden. Sign in to view." Message: "You have a new message in ChartWarden. Sign in to view." Field safety: "ChartWarden safety alert. Sign in to view." Every other category: "You have a new notification in ChartWarden. Sign in to view." The only thing a category adds is the urgency level; no sender role, no patient, channel or message reference. Email subject is the constant "ChartWarden notification", push title the constant "ChartWarden".
4. **The link is fixed and opaque.** `{origin}/n/{notification_delivery id}` only. The id must match `[A-Za-z0-9_-]{1,64}` and the base must be a plain http(s) origin (no credentials, query or fragment); otherwise the link is dropped (never rewritten) and the wording ("Sign in to view.") stands alone. No token, patient, channel or message id ever appears. Postmark click tracking is already off, so the link is not rewritten through a third party.
5. **SMS length is enforced on the whole body** (wording plus link, 160 characters); if it does not fit, the link is dropped, not the wording.
6. **Tenant-edited templates cannot loosen this by construction and by test.** The dispatch and notification directories import no template, composer or payload module (a static test), so a tenant overlay, an alert payload field or a new template variable has no path to a vendor. Nothing is stored in the database for this, so there is no migration and no flag.
7. **Coverage guard instead of an arch gate.** A vitest in `packages/messaging/__tests__/lock-screen-privacy.test.ts` lists every file that calls a vendor (`postToVendor`, `sendTwilioSms`, `sendPostmarkEmail`, the vendor hosts) with a reason. A new sender not on the list fails; the three alert transports must call `renderOutOfBand`; no file under `dispatch/` or `notification/` other than `sanitize.ts` may reference `.short`, `.deepLink`, their bracket forms or destructure them; and no file there imports a vendor SDK (twilio, web-push, nodemailer, postmark, AWS SES/SNS), including via `require()` or `import()`, or calls `fetch` unless it is on the audited list. The existing audited exceptions: auth links (reset, magic link: pre-session, no PHI source, a token link by design) and the endpoint verification code (fixed text plus a one-time code). **Ceiling:** a static grep cannot prove a negative. Aliasing (`const k = "sh" + "ort"`), a re-exported helper, a sender in a directory the guard does not scan, or a vendor reached through a new module on the audited list would pass. The runtime provenance check in decision 2 is the real control; the guard only catches the accidental, ordinary case.

## Alternatives considered

- **A branded TypeScript type only.** Rejected as the sole defence: it does not stop a cast or an `as` in a test or a future caller; the runtime registry fails safe.
- **Reject (throw) an unproven notification.** Rejected: it would drop a designated safety route. Generic text is always deliverable.
- **A new `arch:` gate.** Rejected for now: the vitest is small, runs in the existing suite, and the list of senders is short.
- **Keep "clinical" in the urgent line.** Rejected: it tells a bystander the owner does clinical work; "urgent request" carries the same call to action.

## Consequences

- Out-of-band text changed (fixed strings only). The in-app alert text is untouched.
- A web-push payload now carries `title` besides `id`, `short` and `deepLink`; the consuming service worker (WP 4.8) must treat all four as non-sensitive.
- `/n/:id` is the WP 4.8 route ([ADR-0075](ADR-0075-messaging-deep-link-landing.md)): it requires an authenticated session, reveals nothing before sign-in, and the server checks that the delivery's recipient and organisation match the session (an opaque id is not an access grant).
- The SOS emergency-contact script is voice-only: it is bound to the voice channel and is never reused on a text channel.

## Known ceilings

- Not covered: step-up (MFA) one-time codes sent by the identity module, and the auth links above; they are not alert content and have a different threat model.
- Open item for the M20 owner (pre-existing, not changed here): the web-push transport posts to the subscription endpoint with no host restriction beyond https, a limited SSRF risk (SSRF-lite); the endpoint should be restricted to known push services.
- The wording is the clinical lead's decision (brief section 9); it is changed in one place.
