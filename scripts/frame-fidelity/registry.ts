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
];
