/**
 * COP27 API seed — the FY2027 election statement addendum (42 CFR 418.24(c)/(d)) over its admission routes.
 *
 * The addendum lives on the admission: `GET /admissions/:id/election-addendum` is the overview (required?,
 * current version, history, open (d)(1)/(d)(2) windows); POST drafts (or, after a furnished version, opens
 * the next one as a plan-of-care update); PATCH fills a draft; furnish / signature / refusal acknowledge it.
 */
import { TERMINAL_DX } from "./admission";
import type { SeedContext } from "./context";
import { asAnyone, readAsAnyone } from "./http";
import type { ScenarioRun } from "./run";

export interface AddendumVersion {
  id: string;
  updatedAt: string;
  versionNumber: number;
  trigger: string;
  status: string;
  hospiceName: string | null;
  patientName: string | null;
  medicalRecordNumber: string | null;
  terminalDiagnosis: Array<{ icd10Code: string | null; description: string }>;
  items: Array<{ category: string; description: string; reasonNotCovered: string }>;
  noNonCoveredItems: boolean;
  clinicalExplanation: string | null;
  dueAt: string | null;
  furnishedAt: string | null;
  signedAt: string | null;
  refusedAt: string | null;
  signatureNotRequiredReason: string | null;
  version: number;
}

export interface AddendumOverview {
  required: boolean;
  electionEffectiveDate: string | null;
  inCare: boolean;
  current: AddendumVersion | null;
  history: AddendumVersion[];
  openWindows: Array<{ id: string; kind: string; status: string; dueAt: string }>;
}

export async function readAddendum(
  ctx: SeedContext,
  admissionId: string,
): Promise<AddendumOverview | null> {
  return readAsAnyone<AddendumOverview>("read election addendum", ctx.sessions, (s) =>
    s.client.GET("/api/v1/admissions/{id}/election-addendum", {
      params: { path: { id: admissionId } },
    }),
  );
}

export const describeAddendum = (o: AddendumOverview): string => {
  const c = o.current;
  const windows = o.openWindows.map((w) => `${w.kind} due ${w.dueAt.slice(0, 10)}`).join(", ");
  return `required=${o.required} effective=${o.electionEffectiveDate} current=${c ? `v${c.versionNumber} ${c.status}` : "none"}${windows ? ` windows=[${windows}]` : ""}`;
};

/** v1 exists (activation opens it for an election effective on/after 2026-10-01; a transfer-in drafts it). */
export async function ensureAddendumDraft(
  run: ScenarioRun,
  ctx: SeedContext,
  admissionId: string,
): Promise<AddendumOverview> {
  return run.ensure(
    "addendum v1 opened",
    async () => {
      const o = await readAddendum(ctx, admissionId);
      return o?.current ? o : null;
    },
    async () => {
      await asAnyone("draft addendum", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/election-addendum", {
          params: { path: { id: admissionId } },
          body: {},
        }),
      );
      const o = await readAddendum(ctx, admissionId);
      if (!o?.current) throw new Error("no addendum after draft");
      return o;
    },
    describeAddendum,
  );
}

const SETTLE_POLL_MS = 2_000;
const SETTLE_MAX_MS = 180_000;

/**
 * Let the asynchronous plan-of-care consumers bring the v1 draft up to date before it is furnished.
 *
 * Coverage determinations (M12/M21) and unrelated problems (M7) reach the addendum through outbox consumers
 * that refresh the draft. Once a version is furnished they open a new version only when the source items
 * actually differ, so a late event for an item v1 already lists is a no-op. This waits until the draft lists
 * what `expect` needs; if the relay is slower than {@link SETTLE_MAX_MS} it refreshes the draft synchronously.
 */
export async function ensureAddendumSettled(
  run: ScenarioRun,
  ctx: SeedContext,
  admissionId: string,
  label: string,
  expect: (items: AddendumVersion["items"]) => boolean,
): Promise<void> {
  const v1 = async () =>
    (await readAddendum(ctx, admissionId))?.history.find((v) => v.versionNumber === 1) ?? null;
  await run.ensure(
    `addendum v1 lists ${label}`,
    async () => {
      const v = await v1();
      return v && v.status !== "draft" ? v : null;
    },
    async () => {
      const started = Date.now();
      while (Date.now() - started < SETTLE_MAX_MS) {
        const v = await v1();
        if (v && expect(v.items)) return v;
        await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      }
      await asAnyone("refresh addendum draft", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/election-addendum", {
          params: { path: { id: admissionId } },
          body: {},
        }),
      );
      const v = await v1();
      if (!v || !expect(v.items))
        throw new Error(`the addendum does not list ${label} after a refresh`);
      return v;
    },
    (v) => v.items.map((i) => `${i.category}: ${i.description}`).join("; ") || v.status,
  );
}

export interface AddendumContent {
  readonly hospiceName: string;
  readonly patientName: string;
  readonly mrn: string;
  readonly clinicalExplanation: string;
}

/** Fill the fields the source readers could not (furnish refuses an incomplete addendum). */
export async function ensureAddendumContent(
  run: ScenarioRun,
  ctx: SeedContext,
  admissionId: string,
  content: AddendumContent,
): Promise<void> {
  await run.ensure(
    "addendum content complete",
    async () => {
      const c = (await readAddendum(ctx, admissionId))?.history.find((v) => v.versionNumber === 1);
      if (!c) return null;
      if (c.status !== "draft") return c.status;
      const complete =
        !!c.hospiceName &&
        !!c.patientName &&
        !!c.medicalRecordNumber &&
        c.terminalDiagnosis.length > 0 &&
        (c.items.length > 0 ? !!c.clinicalExplanation : c.noNonCoveredItems);
      return complete ? "complete" : null;
    },
    async () => {
      const c = (await readAddendum(ctx, admissionId))?.history.find((v) => v.versionNumber === 1);
      if (!c) throw new Error("no addendum draft");
      await asAnyone("fill addendum", ctx.sessions, (s) =>
        s.client.PATCH("/api/v1/admissions/{id}/election-addendum/{addendumId}", {
          params: { path: { id: admissionId, addendumId: c.id } },
          body: {
            ifVersion: c.version,
            ...(c.hospiceName ? {} : { hospiceName: content.hospiceName }),
            ...(c.patientName ? {} : { patientName: content.patientName }),
            ...(c.medicalRecordNumber ? {} : { medicalRecordNumber: content.mrn }),
            ...(c.terminalDiagnosis.length > 0
              ? {}
              : {
                  terminalDiagnosis: [
                    { icd10Code: TERMINAL_DX.icd10, description: TERMINAL_DX.text },
                  ],
                }),
            ...(c.items.length > 0
              ? c.clinicalExplanation
                ? {}
                : { clinicalExplanation: content.clinicalExplanation }
              : { noNonCoveredItems: true }),
          },
        }),
      );
      return "complete";
    },
    (v) => v,
  );
}

/** Furnish the current draft in writing; `furnishedAt` back-dates a paper hand-over (never the future). */
export async function ensureAddendumFurnished(
  run: ScenarioRun,
  ctx: SeedContext,
  admissionId: string,
  furnishedAt: string,
): Promise<void> {
  await run.ensure(
    "addendum furnished (paper)",
    async () => {
      const c = (await readAddendum(ctx, admissionId))?.history.find((v) => v.versionNumber === 1);
      return c?.furnishedAt ? c.furnishedAt : null;
    },
    async () => {
      const c = (await readAddendum(ctx, admissionId))?.history.find((v) => v.versionNumber === 1);
      if (!c) throw new Error("no addendum to furnish");
      await asAnyone("furnish addendum", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/election-addendum/{addendumId}/furnish", {
          params: { path: { id: admissionId, addendumId: c.id } },
          body: { ifVersion: c.version, method: "paper", furnishedAt },
        }),
      );
      return furnishedAt;
    },
    (at) => `furnished ${at.slice(0, 10)}`,
  );
}

export type AddendumAcknowledgement =
  | { readonly kind: "signed"; readonly signedAt: string }
  | {
      readonly kind: "refused";
      readonly reason: string;
    };

export async function ensureAddendumAcknowledged(
  run: ScenarioRun,
  ctx: SeedContext,
  admissionId: string,
  ack: AddendumAcknowledgement,
): Promise<void> {
  await run.ensure(
    ack.kind === "signed" ? "addendum signed (beneficiary)" : "addendum refused (representative)",
    async () => {
      const v1 = (await readAddendum(ctx, admissionId))?.history.find((v) => v.versionNumber === 1);
      return v1 && (v1.signedAt || v1.refusedAt) ? v1.status : null;
    },
    async () => {
      const c = (await readAddendum(ctx, admissionId))?.history.find((v) => v.versionNumber === 1);
      if (!c) throw new Error("no addendum to acknowledge");
      if (ack.kind === "signed") {
        await asAnyone("record addendum signature", ctx.sessions, (s) =>
          s.client.POST("/api/v1/admissions/{id}/election-addendum/{addendumId}/signature", {
            params: { path: { id: admissionId, addendumId: c.id } },
            body: { ifVersion: c.version, signerKind: "beneficiary", signedAt: ack.signedAt },
          }),
        );
        return "signed";
      }
      await asAnyone("record addendum refusal", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/election-addendum/{addendumId}/refusal", {
          params: { path: { id: admissionId, addendumId: c.id } },
          body: { ifVersion: c.version, reason: ack.reason },
        }),
      );
      return "refused";
    },
    (status) => status,
  );
}
