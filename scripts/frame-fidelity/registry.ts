// WardenX — Frame-Fidelity Registry
// ----------------------------------
// The hand-maintained bridge between a BUILT web screen and the Pencil FRAME it should match,
// plus how far that match has progressed. This is the source of truth the frame-fidelity report
// (scripts/report-frame-fidelity.ts) validates and summarizes. See the process in
// docs/design/FRAME_FIDELITY_PLAYBOOK.md.
//
// Why a hand registry (not an automatic join): SCREENS.md keys frames by feature name; apps/web keys
// screens by registered `id`. There is no shared key, so the link is declared explicitly here — one
// row per screen we have taken through the playbook. `frameNode` MUST exist in docs/design/SCREENS.md
// (the report hard-fails on an unknown node, catching typos).

/** How far a built screen's composition has been matched to its Pencil frame. */
export type FidelityStatus =
  | "pending" // built, not yet matched to the frame's composition
  | "partial" // composition matches; some regions are honest placeholders awaiting other modules
  | "matched"; // composition matches and every region renders real data

export interface FrameFidelityEntry {
  /** Registered web screen id (apps/web `screens.ts`), or a `shell.*` id for app-shell surfaces. */
  readonly screenId: string;
  /** Human label (matches the SCREENS.md row). */
  readonly screen: string;
  /** Owning module(s). */
  readonly module: string;
  /** Pencil frame node id (without the `node:` prefix) — must appear in docs/design/SCREENS.md. */
  readonly frameNode: string;
  /** The `.pen` file the frame lives in. */
  readonly penFile: string;
  readonly status: FidelityStatus;
  /** What is real vs. placeholder — the honest accounting the playbook requires. */
  readonly notes: string;
}

export const FRAME_FIDELITY: readonly FrameFidelityEntry[] = [
  {
    screenId: "saas.feature-flags",
    screen: "Feature Flags",
    module: "M34",
    frameNode: "bxUqf",
    penFile: "wardenx-P4-admin-platform.pen",
    status: "partial",
    notes:
      "Added the frame's KPI strip (total / enabled / kill-switches / per-tenant, counted from the loaded " +
      "flags) over the existing flags Work Queue — table (key · scope · kind · value · kill-switch state) + " +
      "right detail panel + the §6/D10 confirm-by-typing kill-switch CeremonyModal. All real (GET " +
      "/platform/feature-flags). Honest gaps: no separate count endpoint, so KPIs reflect the loaded page; " +
      "the frame's per-row enable TOGGLES aren't replicated as a generic write (only the step-up-gated " +
      "kill-switch is a real write path) — the kill-switch ceremony is kept instead.",
  },
  {
    screenId: "shell.role-home",
    screen: "App Shell & Role Home",
    module: "M01",
    frameNode: "AQAhY",
    penFile: "wardenx-P0-foundation.pen",
    status: "partial",
    notes:
      "Role-home launcher reconciled to Lantern (Fraunces headline, No-Line tiles on warm paper). " +
      "Role-curated dashboard widgets (My Patients, AR snapshot, cosign queue) await their modules.",
  },
  {
    screenId: "idg.meeting-detail",
    screen: "IDG Meeting",
    module: "M14",
    frameNode: "Wqf1e",
    penFile: "wardenx-P1-clinical.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's 3-pane meeting view: a meeting header (status + packets-ready + Live surface) " +
      "over a packet list | the selected patient's review packet | a right rail (attendance/quorum + " +
      "schedule). REAL: meeting lifecycle/schedule, the packet-readiness list + freeze state, packets-ready " +
      "count. Honest gaps: the packets read carries patient + freeze state, NOT the packet content " +
      "(as-presented summary / eligibility / recommendations live on the full packet, /packets/:patientId) — " +
      "so the center is a section scaffold + Open full packet; and attendance/quorum isn't on these reads " +
      "(it's on the live meeting surface), so that rail is an honest placeholder.",
  },
  {
    screenId: "hope.assessment-detail",
    screen: "HOPE Assessment",
    module: "M10",
    frameNode: "KQ8kz",
    penFile: "wardenx-P1-clinical.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's Patient Workspace: banner | HOPE timepoint rail (real patient HOPE timeline) " +
      "| the timepoint's section list + clinical-context snapshot | a right rail (validation & triggers + " +
      "iQIES submission), over a sticky footer (submission guard + actions). REAL: timepoint rail, status/" +
      "target/author/signed metadata, J2051 max-severity + SFV trigger, the D8 PPS/ESAS-r snapshot, and the " +
      "validation findings. Honest gap: per-section completion isn't exposed (section data is opaque " +
      "server-side except Section J/J2051), so the section list shows J2051 real and the rest 'completion " +
      "not exposed —', never fabricated completeness. NB the frame maps to hope.assessment-detail (the " +
      "section view), not the patient HOPE timeline.",
  },
  {
    screenId: "emar.patient-emar",
    screen: "Medications — Prescribing & eMAR",
    module: "M13",
    frameNode: "ANbhv",
    penFile: "wardenx-P1-clinical.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's MAR Grid: Patient Workspace (banner + module rail) | the Medication " +
      "Administration Record grid (rows = medication orders, columns = dose times, cells = the dose's §2.2 " +
      "status, selectable) + a recent-administrations strip | a right 'Administer' rail (five-rights " +
      "scaffold). REAL: scheduled-dose grid + administration history + late-entry/controlled/RN-review " +
      "pills. Honest gaps: dose rows carry the medication ORDER id, not the drug/dose text the frame shows " +
      "(no fabricated drug name); the administration WRITE paths (single-dose/PRN/witness) aren't built, so " +
      "Record administration is an inert scaffold naming the write path.",
  },
  {
    screenId: "orders.patient-list",
    screen: "Orders",
    module: "M11",
    frameNode: "pQiC0",
    penFile: "wardenx-P1-clinical.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's Patient Workspace: banner + module rail | orders table (kind · priority · " +
      "status · live 48h verbal countdown, row-select) | right rail with the selected order's detail + " +
      "Open order. All real (M11 order lifecycle data + CountdownChip on the real verbal deadline). Honest " +
      "gap: the list carries the order KIND, not the clinical order text (drug/dose) the frame shows — that " +
      "lives on /orders/:id — so rows label by kind, never a fabricated drug name.",
  },
  {
    screenId: "encounter.read",
    screen: "Encounter / Visit Documentation",
    module: "M08",
    frameNode: "AohyV",
    penFile: "wardenx-P1-clinical.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's Patient Workspace: banner | visit-note document (note title + status, a " +
      "vitals strip, a SUBJECTIVE/OBJECTIVE/ASSESSMENT/PLAN scaffold) | right rail (Sign-off + EVV/visit), " +
      "over a sticky footer (cosign guard + actions). REAL: header (type/discipline/date/status/late-entry/" +
      "version), cosignature state, signed/cosigned timestamps, patient banner, the four sign/cosign " +
      "ceremonies (/sign, /cosignature/acknowledge, /cosignature/sign, /cosignature/supervisor-release — " +
      "TASK-031, real step-up + 412/403 handling), and — since #92 — the vitals strip, bound to the real " +
      "GET /encounters/:id/vitals (newest set, per-cell units, abnormal tone from the server's own " +
      "flags; an em dash now means 'nobody recorded it', not 'the API can't say'). Honest " +
      "placeholders — the SOAP sections still render '—', but the reason has changed: since #114 the " +
      "note body IS persisted (PATCH .../selections writes hearthnote_selection and reads back " +
      "assembled), and this SCREEN is simply not bound to that read yet — never a fabricated note; " +
      "EVV/visit join (M17/M18) isn't on the DTO; the footer's Save-draft is the one unbuilt write " +
      "path (#91). This note used to say Sign-note was unbuilt too — it is not, and an external audit " +
      "repeated that back as a release blocker (#107).",
  },
  {
    screenId: "assessment.timeline",
    screen: "Clinical Assessments Suite",
    module: "M09",
    frameNode: "aSIwN",
    penFile: "wardenx-P1-clinical.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's Patient Workspace: banner | scale list | selected scale's score + capture " +
      "history | a right-rail score trend. REAL throughout (scales, per-capture total scores + " +
      "interpretation, captured-at/by, cosign-needed, SUD/redacted, the trend bars computed from the real " +
      "score series). Honest substitution — the timeline exposes each capture's TOTAL score, not the " +
      "per-item breakdown the frame's symptom bars show, so the center shows the score + history rather " +
      "than fabricating per-symptom values.",
  },
  {
    screenId: "care-plan.view",
    screen: "Care Plan",
    module: "M07",
    frameNode: "UaKVf",
    penFile: "wardenx-P1-clinical.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's Patient Workspace: patient banner + module nav rail | a document-style " +
      "'Interdisciplinary care plan' card (every problem with its goals + interventions inline) | a right " +
      "rail (IDG review + AI suggestion), over a sticky footer (IDG-quorum guard + actions). REAL: " +
      "problems/goals/interventions, version+signers, patient banner. Honest substitutions — AI suggestion " +
      "is a placeholder (M29 Clinical Copilot not built, no fabricated suggestion); no next-review date in " +
      "the API (CoP note + signers shown instead); footer uses the real nav actions (Version history / " +
      "summary / open draft) rather than the frame's unbuilt Save-draft / Submit-for-IDG write paths.",
  },
  {
    screenId: "patient.chart",
    screen: "Patient Chart",
    module: "M05",
    frameNode: "fQjjh",
    penFile: "wardenx-P0-foundation.pen",
    status: "partial",
    notes:
      "Banner (avatar + Fraunces name + DOB·age meta + MRN/status chips + Message action), icon nav " +
      "rail, and Summary card composition + right Alerts/Tasks rail all match the frame. Problems / " +
      "benefit-period / alerts / tasks cards are honest placeholders (Care Plan, Admission, Tasks modules).",
  },
  {
    screenId: "identity.sign-in",
    screen: "Authentication & Session — Sign in",
    module: "M02",
    frameNode: "a1dbhD",
    penFile: "wardenx-P0-foundation.pen",
    status: "matched",
    notes:
      "Rebuilt to the frame's 'Card Sign in': gold hearth mark + Fraunces 'WardenX' lockup, Sign in " +
      "title + subtitle, filled fields, full-width pill button, and a 'Forgot password? · Use a passkey' " +
      "links row. Fully real — email/password + passkey both go through Better Auth; no placeholders.",
  },
  {
    screenId: "identity.mfa-challenge",
    screen: "Authentication & Session — Two-factor verification",
    module: "M02",
    frameNode: "a1dbhD",
    penFile: "wardenx-P0-foundation.pen",
    status: "matched",
    notes:
      "Rebuilt to the frame's 'Card Two-factor verification' (same a1dbhD frame as Sign in): branded " +
      "card, Fraunces title + subtitle, a segmented 6-digit mono OTP input (auto-advance + paste), " +
      "full-width pill Verify. Fully real (TOTP + backup code via Better Auth). The frame's 'Resend " +
      "code' link — which implies SMS/email OTP — is replaced by the functional backup-code toggle " +
      "(our 2FA is authenticator/TOTP, which has no resend).",
  },
  {
    screenId: "messaging.notifications",
    screen: "Notifications & Tasks",
    module: "M01 · M36",
    frameNode: "mK4co",
    penFile: "wardenx-P0-foundation.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame: Fraunces title, Notifications/Tasks/Mentions pill tabs + an inline stats " +
      "strip, and a §6.2 No-Line card of rows (severity glyph + summary + source chip + status pill + " +
      "relative time). The Notifications tab is the REAL alert inbox (GET /api/v1/alerts/inbox) with " +
      "live Unread/Urgent/Failed stats; Tasks & Mentions are honest placeholders (Tasks/worklist module).",
  },
  {
    screenId: "messaging.staff",
    screen: "Staff Messaging",
    module: "M36",
    frameNode: "A016Y",
    penFile: "wardenx-P0-foundation.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's Conversation View: a 'Messages' list (avatar + title + scope + unread dot, " +
      "active row indigo-tinted) | a thread of chat bubbles (mine right/indigo via the real session user " +
      "id, others left/paper) under a patient-scoped chip header, over a rounded composer. All real M36 " +
      "data; the list's last-message preview/time isn't exposed by the channels read yet, so the secondary " +
      "line shows the channel's real scope instead.",
  },
  {
    screenId: "system.pages",
    screen: "System / Utility Pages",
    module: "M01",
    frameNode: "dT1Bt",
    penFile: "wardenx-P0-foundation.pen",
    status: "matched",
    notes:
      "All 7 chromeless states (404/403/500/offline/maintenance/session-expired/suspended) render the " +
      "System Page pattern matched to the frame: a circular tonal icon badge holding a Lantern inline-SVG " +
      "Glyph (replacing the old emoji — §10.10), Fraunces headline, muted explanation, forward action, mono " +
      "correlation id. CenteredStatusLayout enhanced to draw the badge.",
  },
  {
    screenId: "search.global",
    screen: "Global Search Results",
    module: "M01 · M33",
    frameNode: "Cp053",
    penFile: "wardenx-P0-foundation.pen",
    status: "partial",
    notes:
      "Rebuilt to the frame's centered results column: per-scope No-Line cards with avatar + name + " +
      "meta + status + chevron rows that navigate to the record. Patient + staff scopes are REAL " +
      "(RLS/caseload + member.manage scoped); documents/orders/visits/commands are honest 'available " +
      "when <module> ships' rows.",
  },
  {
    screenId: "patient.census",
    screen: "Patient List / Census",
    module: "M05",
    frameNode: "DNqXm",
    penFile: "wardenx-P0-foundation.pen",
    status: "partial",
    notes:
      "Header (title + Admit action), KPI strip, work table, and right detail panel match the frame. " +
      "Census KPI is the REAL active count (GET /patients/census-metrics); Admissions/Discharges/GIP/" +
      "Recerts KPIs are honest '—' placeholders noting their owning module (M6 / billing).",
  },
  {
    screenId: "admission.discharge",
    screen: "Discharge / Revocation / Transfer",
    module: "M06",
    frameNode: "m8VaU",
    penFile: "wardenx-P2-operational.pen",
    status: "pending",
    notes:
      "Built as a stepper workflow (Reason -> Details -> Effective date -> Review -> Confirm) in the " +
      "patient workspace on the 2026-09-25 redesign kit; not yet matched region-by-region to the frame. " +
      "All writes are REAL (POST /admissions/:id/discharge | /revocation | /transfer-out). The rail's " +
      "current benefit period is best-effort from election-certification. Honest gaps: no death path " +
      "(Death & Pronouncement workflow), no for-cause cosign screen, and transfer-out does not yet record " +
      "home vs facility care at the receiving hospice (backend field pending).",
  },
];
