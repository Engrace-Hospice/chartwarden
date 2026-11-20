// apps/backend/src/modules/08-encounters/drafting/workspace-read.ts — the workspace fields of `getEncounter` and the pinned-note readers (S1;
// ADR-0114 VN-D13, VN-D30). Moved out of the Drizzle service so it does not grow with every amendment rule; no behaviour of its own.
//
// Two halves, so no pooled connection is held while another is asked (S3): `rowsFor` reads everything the workspace needs on the caller's
// transaction and opens nothing, asks no seam; `render` runs AFTER that transaction closed, opens the sealed text under the tenant DEK and asks the
// Part 2 verdict ONCE for the note view, its history and the addenda's section ids together (B4).
import { type DbClient, schema } from "@chartwarden/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { cosignDisplayStatus } from "../cosignature/subject";
import type { HearthnoteEnvelopeCipher } from "../hearthnote-crypto";
import { EncounterStateError } from "../lifecycle/errors";
import {
  type NoteHistory,
  type NoteOriginal,
  type NoteVersionRows,
  type StructuredNoteView,
  addendumVisibleTo,
  loadNoteVersionRows,
  renderNoteVersions,
} from "./note-versions";
import type { DraftSeamPorts, DraftViewer } from "./ports";

const SEL = schema.hearthnoteSelections;
const VITALS = schema.vitals;
const MILEAGE = schema.mileage;
const LINK = schema.encounterCarePlanLinks;
const ADDENDUM = schema.encounterAddenda;
const ADDENDUM_COSIGN = schema.addendumCosignatureRequests;
const AMENDMENT = schema.encounterAmendments;

/** Timestamptz → ISO string (drizzle returns a Date for `withTimezone` columns). */
const iso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v : v.toISOString();

export interface WorkspaceReadDeps {
  /** The per-tenant narrative envelope; unbound, the pinned narrative cannot be shown at all. */
  readonly narrativeCipher: HearthnoteEnvelopeCipher | undefined;
  /** Runs one tenant-DEK operation, turning a key-resolve failure into the service's designed 503. */
  readonly withTenantDek: <T>(what: string, run: () => Promise<T>) => Promise<T>;
  /** The seam-backed half of the draft ports (M7, M9, M12, M39); resolved per call. */
  readonly draftSeams: () => DraftSeamPorts;
}

/** What `render` needs of the encounter row. */
export interface WorkspaceEncounter {
  readonly id: string;
  readonly patientId: string;
  readonly authoredByMembershipId: string;
  readonly signedAt: Date | string | null;
}

/** The workspace rows as stored: nothing opened, no verdict asked. */
export type WorkspaceRows = Awaited<ReturnType<typeof workspaceRowsOf>>;

/** The note as `viewer` may see it: the current view, its history, and the section ids a reader without disclosure is not told. */
interface FinalPayload {
  readonly text: string | null;
  readonly view: StructuredNoteView | null;
  readonly history: NoteHistory | null;
  readonly withheldSectionIds: ReadonlySet<string>;
}

export interface WorkspaceReader {
  /** Opens one pinned narrative envelope under the tenant DEK; unbound, the pinned narrative cannot be shown at all. */
  readonly openPinned: (organizationId: string) => (cipher: string) => Promise<string>;
  /**
   * Whether `viewer` may read this patient's 42 CFR Part 2 content: M39's per-actor verdict, the one the draft asks (a failure is not a "no",
   * see `readPinnedNote`). A document consumer has no viewer and is never entitled: documents are broadly readable (design 3.1).
   */
  readonly part2Entitlement: (
    organizationId: string,
    patientId: string,
    viewer: DraftViewer | null,
  ) => () => Promise<boolean>;
  /** The database half of the workspace fields: every read on the caller's transaction, nothing opened and no seam asked (S3). */
  readonly rowsFor: (t: DbClient, encounterId: string) => Promise<WorkspaceRows>;
  /** The workspace fields of `getEncounter` for `viewer`: the rows read in the transaction, the note rendered after it closed (S3). */
  readonly render: (
    organizationId: string,
    encounter: WorkspaceEncounter,
    viewer: DraftViewer,
    rows: WorkspaceRows,
  ) => Promise<RenderedWorkspace>;
}

type RenderedWorkspace = Omit<WorkspaceRows, "noteRows"> & {
  readonly finalDocumentation: string | null;
  readonly finalDocumentationView: StructuredNoteView | null;
  readonly noteHistory: NoteHistory | null;
};

export function createWorkspaceReader(deps: WorkspaceReadDeps): WorkspaceReader {
  const { narrativeCipher, withTenantDek } = deps;

  const part2Entitlement: WorkspaceReader["part2Entitlement"] =
    (organizationId, patientId, viewer) => async () =>
      viewer !== null &&
      deps.draftSeams().part2DisclosureAllowed({ organizationId, patientId, viewer });

  const openPinned: WorkspaceReader["openPinned"] = (organizationId) => (cipher) => {
    if (!narrativeCipher) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        "the encounter's narrative is pinned but no per-tenant DEK envelope is bound to open it",
      );
    }
    return withTenantDek("the pinned narrative could not be opened", () =>
      narrativeCipher.open(organizationId, cipher),
    );
  };

  /** The note's pin, sealed rows and amendment rows as stored (S3: read inside the transaction, opened and judged after it closes), or `null`
   *  when nothing is pinned yet or no DEK cipher is bound to open it. */
  const noteRowsFor = (t: DbClient, encounterId: string): Promise<NoteVersionRows | null> =>
    narrativeCipher ? loadNoteVersionRows(t, encounterId) : Promise.resolve(null);

  /** The pinned (finalize-time or signed) narrative as `viewer` may see it (VN-D13: Part 2 sections withheld from a viewer without disclosure),
   *  or nothing when no rows were loaded. `final_cipher` is sealed under the tenant DEK (#122); never project it raw. With amendments (VN-D30)
   *  it is the CURRENT view, the latest signed text per section, and the history of each amended section comes with it; without any it is the
   *  sealed sections joined (the pin's final text, by the invariant the rows keep), or the pin itself when it has no sealed rows, and the
   *  history is `null`. Runs AFTER the read transaction closed: the cipher open and the M39 verdict each use a pooled connection of their own
   *  (S3), and the verdict is asked once for the view, the history and the addenda's section ids together (B4). */
  async function renderFinalPayload(
    organizationId: string,
    encounter: WorkspaceEncounter,
    viewer: DraftViewer,
    rows: NoteVersionRows | null,
  ): Promise<FinalPayload> {
    if (rows === null) {
      return { text: null, view: null, history: null, withheldSectionIds: new Set() };
    }
    const original: NoteOriginal = {
      authoredByMembershipId: encounter.authoredByMembershipId,
      signedAt: encounter.signedAt === null ? null : new Date(encounter.signedAt),
    };
    const versions = await renderNoteVersions(rows, original, {
      open: openPinned(organizationId),
      entitled: part2Entitlement(organizationId, encounter.patientId, viewer),
    });
    return {
      text: versions.current.text,
      view: versions.current.structured,
      history: versions.history,
      withheldSectionIds: versions.withheldSectionIds,
    };
  }

  async function render(
    organizationId: string,
    encounter: WorkspaceEncounter,
    viewer: DraftViewer,
    rows: WorkspaceRows,
  ): Promise<RenderedWorkspace> {
    const { noteRows, addenda, ...stored } = rows;
    const final = await renderFinalPayload(organizationId, encounter, viewer, noteRows);
    return {
      ...stored,
      finalDocumentation: final.text,
      finalDocumentationView: final.view,
      noteHistory: final.history,
      // S1: one visibility decision for every field. A reader without disclosure is not told that an addendum named a Part 2 section (signed or
      // not), and an addendum that named only such sections reads as a free addendum, cosignature status included.
      addenda: addenda.map((a) => addendumVisibleTo(a, final.withheldSectionIds)),
    };
  }

  return {
    openPinned,
    part2Entitlement,
    rowsFor: (t, encounterId) => workspaceRowsOf(t, encounterId, () => noteRowsFor(t, encounterId)),
    render,
  };
}

/** The database half of the workspace fields; `noteRows` reads the note's rows (they need the DEK cipher bound). */
async function workspaceRowsOf(
  t: DbClient,
  encounterId: string,
  noteRows: () => Promise<NoteVersionRows | null>,
) {
  const [selection] = await t
    .select({ selections: SEL.selections })
    .from(SEL)
    .where(eq(SEL.encounterId, encounterId))
    .limit(1);
  const [vital] = await t
    .select({
      vitalsId: VITALS.id,
      bpSystolic: VITALS.bpSystolic,
      bpDiastolic: VITALS.bpDiastolic,
      heartRate: VITALS.heartRate,
      respiratoryRate: VITALS.respiratoryRate,
      temperature: VITALS.temperature,
      temperatureUnit: VITALS.temperatureUnit,
      spo2: VITALS.spo2,
      painScore: VITALS.painScore,
      painScale: VITALS.painScale,
      weight: VITALS.weight,
      weightUnit: VITALS.weightUnit,
      height: VITALS.height,
      heightUnit: VITALS.heightUnit,
      bmi: VITALS.bmi,
      bloodGlucose: VITALS.bloodGlucose,
      bloodGlucoseUnit: VITALS.bloodGlucoseUnit,
      clinicallyNotIndicatedFields: VITALS.clinicallyNotIndicatedFields,
      clinicallyNotIndicatedReason: VITALS.clinicallyNotIndicatedReason,
      capturedAt: VITALS.capturedAt,
    })
    .from(VITALS)
    .where(eq(VITALS.encounterId, encounterId))
    .orderBy(desc(VITALS.capturedAt))
    .limit(1);
  const [mileage] = await t
    .select({
      mileageId: MILEAGE.id,
      odometerStart: MILEAGE.odometerStart,
      odometerEnd: MILEAGE.odometerEnd,
      milesDriven: MILEAGE.milesDriven,
      source: MILEAGE.milesDrivenSource,
      manualOverrideReason: MILEAGE.manualOverrideReason,
      routeProposedMiles: MILEAGE.routeProposedMiles,
      capturedAt: MILEAGE.createdAt,
    })
    .from(MILEAGE)
    .where(eq(MILEAGE.encounterId, encounterId))
    .limit(1);
  return {
    selections: (selection?.selections as Record<string, unknown> | undefined) ?? null,
    noteRows: await noteRows(),
    vitals: vital ? { ...vital, capturedAt: iso(vital.capturedAt) } : null,
    mileage: mileage ? { ...mileage, capturedAt: iso(mileage.capturedAt) } : null,
    carePlanLinks: await carePlanLinkRowsFor(t, encounterId),
    addenda: await addendumRowsFor(t, encounterId),
  };
}

/** GAP-027 — the encounter's addenda, oldest first; the UI enables edit/finalize/sign off this status. */
async function addendumRowsFor(t: DbClient, encounterId: string) {
  const rows = await t
    .select({
      id: ADDENDUM.id,
      status: ADDENDUM.status,
      reason: ADDENDUM.reason,
      authoredByUserId: ADDENDUM.authoredByMembershipId,
      createdAt: ADDENDUM.createdAt,
      signedAt: ADDENDUM.signedAt,
      version: ADDENDUM.version,
    })
    .from(ADDENDUM)
    .where(eq(ADDENDUM.encounterId, encounterId))
    .orderBy(asc(ADDENDUM.createdAt), asc(ADDENDUM.id));
  // ADR-0114 VN-D30: where each amendment's own cosignature stands (one read for the encounter), and the sections each addendum names.
  const cosigns = new Map(
    (
      await t
        .select({ addendumId: ADDENDUM_COSIGN.addendumId, status: ADDENDUM_COSIGN.status })
        .from(ADDENDUM_COSIGN)
        .where(eq(ADDENDUM_COSIGN.encounterId, encounterId))
    ).map((request) => [request.addendumId, request.status]),
  );
  const named = await t
    .select({ addendumId: AMENDMENT.addendumId, sectionId: AMENDMENT.sectionId })
    .from(AMENDMENT)
    .where(eq(AMENDMENT.encounterId, encounterId))
    .orderBy(asc(AMENDMENT.sectionId));
  return rows.map((a) => ({
    id: a.id,
    status: a.status as "draft" | "finalized" | "signed",
    reason: a.reason,
    authoredByUserId: a.authoredByUserId,
    createdAt: iso(a.createdAt) ?? "",
    signedAt: iso(a.signedAt),
    version: Number(a.version),
    amendsSectionIds: named.filter((n) => n.addendumId === a.id).map((n) => n.sectionId),
    cosignStatus: cosignDisplayStatus(cosigns.get(a.id) ?? null),
  }));
}

async function carePlanLinkRowsFor(t: DbClient, encounterId: string) {
  const rows = await t
    .select({
      linkId: LINK.id,
      problemId: LINK.problemId,
      goalId: LINK.goalId,
      interventionId: LINK.interventionId,
    })
    .from(LINK)
    .where(and(eq(LINK.encounterId, encounterId), isNull(LINK.removedAt)));
  return rows.map((r) => ({
    linkId: r.linkId,
    problemId: r.problemId ?? null,
    goalId: r.goalId ?? null,
    interventionId: r.interventionId ?? null,
  }));
}
