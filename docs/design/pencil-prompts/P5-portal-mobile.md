# P5 — Portal & Mobile

> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt).
>
> **Portal family constraints (inherited by every screen here):** plain, compassionate,
> non-technical language; **single-column**, large touch targets, large type by default; Fraunces
> warmth in greetings/headings; **WCAG 2.2 AA → AAA** (full keyboard path, high contrast,
> screen-reader labels — the population skews elderly / low-vision / grieving); a **persistent
> after-hours / urgent-care safety affordance** on every screen. Module M31.

## 5.1 Patient / Family Portal Dashboard — M31 · `Use Portal Dashboard`
[spec](../screens/portal/CHARTWARDEN_UI_PATIENT_FAMILY_PORTAL_DASHBOARD.md)
```
Design "Patient / Family Portal Dashboard" for ChartWarden. Portal Dashboard — Portal Header (warm,
Fraunces greeting) over Patient Summary over a single-column card stack: Care Team, Next Visit,
Messages, Documents & Consents, Bereavement Resources (when applicable), Help. Persistent
after-hours safety button. Large type, single column, AAA contrast.
VARIANTS: active-patient family view · bereavement-mode (post-death resources surfaced) ·
empty/first-login · dark.
```

## 5.2 Portal Care Team Messages — M31 · M36 · `Use Conversation View`
[spec](../screens/portal/CHARTWARDEN_UI_PORTAL_CARE_TEAM_MESSAGES.md)
```
Design "Portal Care Team Messages" for ChartWarden. Conversation View (portal) — Conversation List |
Message Thread | Right (care team · what-to-expect / response-time expectations). Plain language,
large bubbles, safety banner persistent. SYSTEMS: async; urgent → redirect to safety affordance,
not chat. VARIANTS: inbox · thread · compose · empty · dark.
```

## 5.3 Portal Documents / Consents — M31 · M22 · M39 · `Use Document Viewer`
[spec](../screens/portal/CHARTWARDEN_UI_PORTAL_DOCUMENTS_CONSENTS.md)
```
Design "Portal Documents / Consents" for ChartWarden. Document Viewer (portal) — Document List |
Document Viewer | Action Panel (View / Sign / Acknowledge). SYSTEMS: consent signing = a calm,
plain-language ceremony (M39); signed/acknowledged status pills; SUD documents respect Part-2
consent. Large type, AAA. VARIANTS: document list · viewer · sign-consent (ceremony) · signed ·
dark.
```

## 5.4 Portal Visit Schedule — M31 · M17 · `Use Portal List`
[spec](../screens/portal/CHARTWARDEN_UI_PORTAL_VISIT_SCHEDULE.md)
```
Design "Portal Visit Schedule" for ChartWarden. Portal List — grouped chronological list (Upcoming /
Past) + item detail (visit type, clinician, date/time). Plain language, single column, large
touch targets. VARIANTS: upcoming · past · visit detail · empty · dark.
```

## 5.5 Telehealth Visit Room — M31 · `Use Media Room`
[spec](../screens/portal/CHARTWARDEN_UI_TELEHEALTH_VISIT_ROOM.md)
```
Design "Telehealth Visit Room" for ChartWarden. Media Room — Video Area (+ participant panel) | Visit
Context | Chat / Notes; controls (join/leave/mute/camera/share). Clinician and patient variants.
SYSTEMS: session-recording explicit consent (ceremony) before capture; connection-quality
indicator; state licensing note. Patient variant = portal constraints (large, plain, accessible).
VARIANTS: clinician room · patient room · pre-call consent (ceremony) · poor-connection ·
waiting-room · dark.
```

---

## Mobile (field) — separate React Native/Expo renderer (ADR-0072)

Mobile is **not** a responsive reflow — it is a parallel **Mobile Task Flow** (one action per
screen). Generate these as a distinct mobile frame set. 44px targets are doubly load-bearing;
offline-capable; queued outbox with sync indicator.

```
Design the ChartWarden "Mobile Field" frame set. One action per screen, large targets, offline-first.
FRAMES: mobile patient list & day schedule · mobile visit documentation (offline, queued) · EVV
check-in (geofence advisory) · EVV check-out · field-safety check-in · field-safety panic/escalate
(ALERT) · offline-queue / sync-status indicator · mobile message threads · mobile task list.
SYSTEMS: offline queue badge + sync status; EVV geofence is advisory (warning, never blocks);
panic = ALERT; PHI respects the same masking/consent rules as desktop.
VARIANTS: each frame above · offline state · sync-in-progress · dark.
```
