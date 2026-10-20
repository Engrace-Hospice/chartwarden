# ADR-0075 — Notification deep link: `/n/:id` is an authenticated landing that resolves an opaque delivery id server-side for its own recipient only

- **Status:** **Accepted** (2026-10-18; decisions closed in the WP 4.8 blueprint). The landing wording is **PROVISIONAL: no clinical-lead sign-off recorded** (brief section 10).
- **Date:** 2026-10-18
- **Phase:** Messaging Hub Phase 4 (WP 4.8, Web/PWA push and deep links).
- **Implements:** `docs/messaging-hub/04-phases-4-to-6.md` WP 4.8 ("deep link opens the right thread/ack card after auth"; acceptance: "cold-start deep link lands on the ack card"). Closes the open item of THREAT_MODEL row I-27.
- **Extends:** [ADR-0074](ADR-0074-messaging-lock-screen-privacy.md) (the content-free link `{origin}/n/{opaque notification_delivery id}`), [ADR-0073](ADR-0073-messaging-notification-policy.md).
- **Related:** ADR-0069 (acknowledgment requests: opening never acknowledges).
- **Numbering note:** the index still has two ADR-0069 files and a missing number between 0071 and 0073 (pre-existing numbering irregularities that `arch:adr-docs` reports). 0075 is the next free number after ADR-0074; this branch adds no `arch:adr-docs` violation naming 0075.

## Context

Checked in the code, not assumed:

- Every push, SMS and email alert carries only `{origin}/n/{id}` (ADR-0074). Until now `/n/:id` had no route in the web app or the API.
- `notification_delivery` is isolated by organisation only (RLS through its parent `alert`); nothing in the database ties a row to the signed-in user. The id in a link is therefore not an access grant: anyone who holds it (a forwarded text, a shared phone) must not learn where it leads unless they are the recipient.
- The alert row already holds the target: the ack, urgent and escalation consumers write `payload.channelId`, `payload.messageId` and `payload.sourceAggregateId` (the message). Nothing needs to be added to the link.
- The web thread screen already reads `/messaging?channelId=&messageId=` (the in-app notification link): it opens the channel, loads the page ending at that message, scrolls to it and highlights it. The acknowledgment card is rendered inside the message row.
- The shell guard sends an anonymous visitor to `/login` and renders no chromed screen first. The sign-in chain (`/login`, `/login/2fa`, `/login/organization`, then a full page load) had no way to return to where the visitor started.
- The web app has no service worker, no web app manifest and no `PushManager` subscription code (a repo search finds none), and no endpoint of type web push can currently be registered from the browser.

## Decisions

1. **A resolver, not a bigger link.** `GET /api/v1/messaging/deliveries/:id/target` (permission `messaging.read`) answers `{channel_id, message_id, ack_request_id}`: three ids, no patient, no name, no text. It runs as the signed-in user inside their organisation and requires, explicitly and on top of RLS, that the delivery's recipient is that user. The target comes from the persisted alert row, never from the request. The message must still exist in that channel in this organisation and not be deleted, and the same channel check the rest of M36 uses (`canViewChannel`) must still pass at resolve time, so a user who lost access since the alert was sent resolves nothing. `ack_request_id` is the open request on that message, if any. No migration (the existing grants and policies suffice), no flag (read-only; with the messaging flags off no deliveries exist), no new event.
2. **One 404.** A missing, malformed, someone else's, other-tenant, deleted, no-longer-visible or target-less delivery is the same `NotFoundError("notification")`: same status, same body, the id is never echoed. The channel check runs on a nil id when the lookup missed, so a hit and a miss do the same work. **Ceiling:** the lookup itself still does a little more work on a hit (one or two extra indexed reads); an exact timing equaliser is not built and the value hidden is a UUID that is already unguessable.
3. **Read-audit.** The route declares `auditRead` with `resourceKind: notification_delivery` and `resourceIdParam: id`; a successful resolve lands a row with the delivery id, a refusal lands none (the read-audit hook emits on 2xx only). The response names no patient, so none is recorded.
4. **The web landing.** `/n/:id` is a **chromed** screen (omitted from navigation: param path). The shell guard therefore sends a signed-out visitor to sign-in before anything of the screen exists: nothing, and no API call, happens before authentication. Signed in, one read resolves the id and the screen replaces itself (history `replace`) with `/messaging?channelId=&messageId=`. While resolving it says only "Opening your notification". Every answer that says "no" (404, 403, any other 4xx, a malformed id) is the same page: "This notification is no longer available", a plain explanation and a link to the messages. A server (5xx), timeout (408), rate-limit (429) or network failure is **not** shown as "gone": it is a separate generic page, "Couldn't open this notification", with a Retry button (still nothing derived from the id). Both pages are a polite status region, not an alert, and move focus to their headline when they replace the resolving line, so a screen reader announces the change. The id, a channel, a message and a patient never appear in the DOM text, the document title, history state, a log or any analytics call.
5. **Return after sign-in, without a URL parameter.** When the guard (or the organisation-selection guard) redirects a visitor away from `/n/<id>` it remembers only the opaque id in `sessionStorage` (15 minutes; the write happens in an effect, not during render). After the organisation is chosen (or, for a forced password change that needs no change, after that check) the app reloads at `/n/<id>` **rebuilt from the stored id** (`[A-Za-z0-9_-]{1,64}`). A stored or supplied string is never replayed as a redirect target, so there is no open redirect by construction: no scheme, host, `//`, backslash, query or fragment can survive the rebuild. The stash is read once, and cleared on sign-out and on the screen-lock sign-out. The id is not a secret and not a token; the server still decides.
6. **Cold start.** A link opened fresh from a push, SMS or email (a new tab or a restored PWA) loads the SPA at `/n/<id>` (the static host already falls back to `index.html`) and runs the same path as above: guard, sign-in if needed, resolve, thread.
7. **Landing on the acknowledgment card.** The thread scrolls to the linked message as before. New: when the thread was opened by a notification link (not by a search hit), the acknowledgment card of that message takes focus once, when its list loads (`AckRequestsProvider landOnMessageId`), unless the person has already moved focus elsewhere. Only the landing card's own focus counts as landed, and the thread screen remembers it, so coming back to the channel while `?messageId=` is still in the URL does not pull focus again. This is reading and focusing only; it sends nothing and never acknowledges (ADR-0069). Acknowledgment stays an explicit button press by the assignee.
8. **Canonical thread route.** The plan row names `/messages/:channel?m=:id`. The thread screen that exists is `/messaging?channelId=&messageId=` (already the target of the in-app alert deep links and the search jump), so the resolver lands there rather than adding a second route to the same screen. A `/messages/...` alias can be added later without changing the link format.
9. **Web push click.** There is no service worker, no manifest and no push subscription code in the web app, so there is no `notificationclick` handler to change and none is built here: a handler without a subscription path would be dead code. The payload already carries the content-free `deepLink`; the future service worker must open only a same-origin URL whose path is exactly `/n/<opaque id>` (the same rule as decision 5) and must treat `title`, `short`, `deepLink` and `id` as non-sensitive. Native FCM/APNs stays a later dispatcher; nothing here builds it.

## Alternatives considered

- **Put channel and message ids in the link.** Rejected: identifiers leak through forwarding, previews, referrers and carrier logs (ADR-0074 decision 4).
- **A `returnTo` query parameter through sign-in.** Rejected: it is attacker-controllable through a crafted link and travels through three screens; the opaque-id stash is rebuilt, not replayed.
- **A SECURITY DEFINER reader.** Rejected: the user's own org-scoped read already sees the alert and delivery rows; a definer function would widen the surface for no gain.
- **Distinguish "not yours" from "gone".** Rejected: that is an existence oracle for someone else's delivery.

## Consequences

- A forwarded link works only for its recipient while they can still see the channel; for anyone else it is the generic page.
- A person who cannot be reached by the page (offline) sees the browser's own offline state, not this page.
- If the session expires while the resolve call is in flight the global 401 handling takes over; the link is then reopened by the person from the message (the id is not re-stashed in that narrow case).
- The landing text is provisional; it is changed in one place (`notification-landing.tsx`).

## Known ceilings

- The static guard on the stored link is one `sessionStorage` key; a shared browser profile with an old entry within 15 minutes (sign-out clears it, an abandoned tab does not) would send the next person to `/n/<that id>`, where the server answers for the new user (usually the generic page). The id carries no content.
- The web push service worker and the native dispatchers are not built (decision 9).
