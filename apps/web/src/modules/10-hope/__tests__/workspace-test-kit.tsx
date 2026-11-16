// Shared fixtures for the HOPE assessment workspace DOM tests: a draft admission assessment, its workspace and
// review models, a mock API client, and the providers the screen needs.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactNode, StrictMode, useEffect, useRef } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeAssessmentDetail } from "../hope-assessment-detail";

export const assessment = {
  id: "hope-1",
  admissionId: "adm-1",
  patientId: "patient-1",
  rfaKind: "01_admission",
  status: "draft",
  targetDate: "2026-09-08T00:00:00.000Z",
  authorDiscipline: "RN",
  j2051MaxSeverity: null,
  j2051TriggerFired: false,
  wasLate: false,
  signedAt: null,
  signedBy: null,
  correctsAssessmentId: null,
  supersededByAssessmentId: null,
  snapshot: null,
  regulatory: { specVersionId: "spec-1", isc: "HA" },
  version: 4,
};

export const patient = {
  mrn: "MRN-123456",
  firstName: "Ada",
  lastName: "Lovelace",
  dob: "1950-01-01",
  status: "active",
};

export function item(overrides: Record<string, unknown>) {
  return {
    itemCode: "A0500A",
    label: "First name",
    section: "A",
    group: null,
    kind: "assessment",
    active: true,
    state: "unanswered",
    value: null,
    source: null,
    answeredAt: null,
    answeredByMembershipId: null,
    applicability: "applicable",
    skipReason: null,
    options: [],
    ...overrides,
  };
}

export function workspace(overrides: Record<string, unknown> = {}) {
  return {
    assessment: {
      id: "hope-1",
      status: "draft",
      rfaKind: "01_admission",
      targetDate: "2026-09-08T00:00:00.000Z",
      isc: "HA",
      specVersionId: "spec-1",
      specVersion: "1.00.1",
      version: 4,
    },
    sections: [
      {
        code: "A",
        label: "Administrative",
        items: [
          item({
            itemCode: "A0220",
            label: "Admission date",
            value: "2026-09-08",
            source: "admission_prefill",
          }),
          item({
            itemCode: "A0500A",
            label: "First name",
            value: "Ada",
            source: "patient_prefill",
            state: "answered",
          }),
          item({
            itemCode: "A0500B",
            label: "Patient middle initial",
            cmsItemTypeCode: "Text",
            maxLength: 1,
            options: [
              { valueCode: "Text", label: "Patient middle initial", sortOrder: 1 },
              { valueCode: "^", label: "Blank", sortOrder: 2 },
            ],
          }),
        ],
      },
      {
        code: "F",
        label: "Preferences",
        items: [
          item({
            itemCode: "F2000A",
            label: "Was CPR discussed?",
            section: "F",
            options: [
              { valueCode: "0", label: "No", sortOrder: 1 },
              {
                valueCode: "1",
                label: "Yes, discussion occurred",
                sortOrder: 2,
              },
            ],
          }),
          item({
            itemCode: "F2000B",
            label: "CPR discussion date",
            section: "F",
            applicability: "not_applicable",
          }),
        ],
      },
      {
        code: "J",
        label: "Health Conditions",
        items: [
          item({
            itemCode: "J2051A",
            label: "Pain impact",
            section: "J",
            group: "Symptom impact",
            applicability: "pending",
          }),
        ],
      },
    ],
    progress: {
      active: 4,
      applicable: 3,
      notApplicable: 1,
      pending: 1,
      answered: 1,
      skipped: 1,
      unanswered: 2,
    },
    ...overrides,
  };
}

export function review(overrides: Record<string, unknown> = {}) {
  return {
    assessmentId: "hope-1",
    version: 4,
    specVersion: "1.00.1",
    isc: "HA",
    status: "draft",
    signedAt: null,
    signedByMembershipId: null,
    z0500b: null,
    sections: [
      {
        code: "A",
        active: 2,
        applicable: 2,
        answered: 2,
        skipped: 0,
        pending: 0,
        unanswered: 0,
        errors: 0,
        warnings: 0,
        state: "complete",
      },
      {
        code: "F",
        active: 2,
        applicable: 1,
        answered: 0,
        skipped: 1,
        pending: 0,
        unanswered: 1,
        errors: 1,
        warnings: 0,
        state: "blocked",
      },
      {
        code: "J",
        active: 1,
        applicable: 0,
        answered: 0,
        skipped: 0,
        pending: 1,
        unanswered: 0,
        errors: 0,
        warnings: 0,
        state: "blocked",
      },
    ],
    progress: {
      active: 5,
      applicable: 3,
      answered: 2,
      skipped: 1,
      pending: 1,
      unanswered: 2,
    },
    validation: {
      errorCount: 1,
      warningCount: 1,
      hasBlockingErrors: true,
      findings: [
        {
          ruleId: "-3060",
          severity: "error",
          section: "F",
          itemCode: "F2000A",
          message: "CPR discussion response is required.",
        },
      ],
    },
    sfv: { required: null },
    readiness: {
      readyToSign: false,
      blockers: [
        {
          code: "PENDING_APPLICABILITY",
          section: "J",
          itemCode: "J2051A",
          message: "J2051 branch is incomplete.",
        },
      ],
    },
    ...overrides,
  };
}

export function ok(data: unknown) {
  return {
    data,
    error: undefined,
    response: new Response(null, { status: 200 }),
  };
}

/** A 409 as the platform sends one: the body is the error envelope, `{ error: { code, message } }`. */
export function err(message: string) {
  return {
    data: undefined,
    error: { error: { code: "CONFLICT", message } },
    response: new Response(null, { status: 409 }),
  };
}

/** The query a lookup of one record's follow-up sends: the server filters the queue by triggering assessment. */
interface SfvQueueInit {
  params?: { query?: { triggeringAssessmentId?: string } };
}

/** What the server does with `triggeringAssessmentId`: only that record's rows (none for an unknown id). */
function filteredQueue(rows: unknown[], init?: SfvQueueInit): unknown[] {
  const wanted = init?.params?.query?.triggeringAssessmentId;
  if (wanted === undefined) return rows;
  return rows.filter(
    (r) => (r as { triggeringAssessmentId?: string }).triggeringAssessmentId === wanted,
  );
}

export function clientFor(
  input: {
    workspace?: unknown;
    review?: unknown;
    assessment?: unknown;
    patchError?: string;
    /** The parsed error body every POST answers with, instead of success. */
    postError?: unknown;
    /** The rows `GET /api/v1/hope/sfv` (the SFV queue) answers with. Read on every call, so a test may change them. */
    sfvs?: unknown[];
    /** How many SFV queue lookups fail with a server error before one succeeds (Infinity: every one). */
    sfvLookupFailures?: number;
    identifiers?: unknown[];
    payers?: unknown[];
    timeline?: unknown[];
  } = {},
): ApiClient {
  let sfvLookupFailuresLeft = input.sfvLookupFailures ?? 0;
  return {
    GET: vi.fn(async (path: string, init?: SfvQueueInit) => {
      if (path === "/api/v1/hope/sfv")
        return sfvLookupFailuresLeft-- > 0
          ? {
              data: undefined,
              error: { error: { message: "The SFV queue is unavailable." } },
              response: new Response(null, { status: 500 }),
            }
          : ok({ sfvs: filteredQueue(input.sfvs ?? [], init) });
      if (path.includes("/workspace")) return ok(input.workspace ?? workspace());
      if (path.endsWith("/identifiers")) return ok({ identifiers: input.identifiers ?? [] });
      if (path.endsWith("/payers")) return ok({ payers: input.payers ?? [] });
      if (path.includes("/review")) return ok(input.review ?? review());
      if (path.includes("/patients/{patientId}/hope/assessments"))
        return ok({ assessments: input.timeline ?? [assessment] });
      if (path.includes("/patients/{id}")) return ok(patient);
      return ok(input.assessment ?? assessment);
    }),
    PATCH: vi.fn(async () =>
      input.patchError
        ? err(input.patchError)
        : ok({ assessmentId: "hope-1", version: 5, answers: [] }),
    ),
    POST: vi.fn(async () =>
      input.postError !== undefined
        ? {
            data: undefined,
            error: input.postError,
            response: new Response(null, { status: 403 }),
          }
        : ok({
            assessmentId: "hope-1",
            status: "signed",
            version: 5,
            signedAt: "2026-09-08T14:00:00.000Z",
            signedByMembershipId: "rn-1",
            z0500b: "2026-09-08",
            validation: {
              errorCount: 0,
              warningCount: 1,
              hasBlockingErrors: false,
            },
          }),
    ),
  } as unknown as ApiClient;
}

/** Stands in for the /step-up page so a redirect is observable as the location it lands on. */
export function StepUpProbe(): JSX.Element {
  const { pathname, search } = useLocation();
  return <output aria-label="step-up location">{`${pathname}${search}`}</output>;
}

/** The refusal `requireStepUp` sends when the session's last re-authentication is stale. */
export const STEP_UP_REFUSAL = {
  error: {
    code: "STEP_UP_REQUIRED",
    message: "A recent re-authentication is required for this operation",
  },
};

/** A signed-in RN: the step-up draft is scoped to org + user, so the round trip needs a session. */
/** A signed-in clinician holding `roles`: the step-up draft is scoped to org + user, so a round trip needs a session. */
export function sessionWith(roles: string[]) {
  return {
    userId: "user-1",
    organizationId: "org-1",
    membershipId: "membership-1",
    roles,
    permissions: [],
    isAdmin: false,
  };
}

/** A signed-in RN. */
export const SESSION = sessionWith(["rn"]);

/** An RN who is also an NP: the server offers both disciplines, so the clinician has to choose one. */
export const SESSION_RN_NP = sessionWith(["rn", "np"]);

/** Every path and query the router has been at, in order (one entry per navigation), since the last `renderWorkspace`. */
export const locationLog: string[] = [];

/** The current path and query, for tests of a navigation that stays on the screen (a removed query parameter). */
function LocationProbe(): JSX.Element {
  const location = useLocation();
  const { pathname, search } = location;
  const loggedKey = useRef<string | null>(null);
  // One entry per navigation, not per effect run: StrictMode runs this effect twice for one location.
  useEffect(() => {
    if (loggedKey.current === location.key) return;
    loggedKey.current = location.key;
    locationLog.push(`${pathname}${search}`);
  }, [location.key, pathname, search]);
  return <span data-testid="current-location">{`${pathname}${search}`}</span>;
}

export function renderWorkspace(
  client: ApiClient,
  session: typeof SESSION | null = null,
  path = "/hope/assessments/hope-1",
  /** Extra controls beside the screen, for a test that navigates between records. */
  extra?: ReactNode,
  /** `strict`: under `React.StrictMode`, which runs every effect twice on mount and so exposes one that is not idempotent. */
  options: { strict?: boolean } = {},
): void {
  locationLog.length = 0;
  const screenTree = (
    <SessionProvider session={session}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        {extra}
        <ApiClientProvider client={client}>
          <Routes>
            <Route path="/hope/assessments/:id" element={<HopeAssessmentDetail />} />
            <Route path="/step-up" element={<StepUpProbe />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>
  );
  render(options.strict ? <StrictMode>{screenTree}</StrictMode> : screenTree);
}

/**
 * Puts `value` on `target[name]` (or removes the property when `value` is undefined) and returns what undoes it: the
 * original own property back as it was, or no property at all when there was none. Assigning the old value back would
 * leave an own property set to `undefined` behind (`"scrollIntoView" in el` stays true, though jsdom has none).
 */
export function stubProperty(target: object, name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, name);
  if (value === undefined) Reflect.deleteProperty(target, name);
  else Object.defineProperty(target, name, { value, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  };
}

/**
 * In-memory storage for each test in the enclosing describe, put back afterwards: the nav-mode choice and visited
 * groups persist through localStorage, and a stub that outlived its test would leak into whichever file runs next.
 */
export function useStubbedLocalStorage(): void {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

/**
 * A workspace whose J section holds the Symptom Follow-Up Visit group: J2052A and the J2053A-B questions.
 * `withAdministrative` puts section A first, as a real admission record opens (the follow-up card is then NOT on screen
 * until the screen moves to J); `recorded` is the workspace after the visit has been recorded on a draft.
 */
export function sfvWorkspace(options: { withAdministrative?: boolean; recorded?: boolean } = {}) {
  const sfvItem = (itemCode: string, label: string, extra: Record<string, unknown> = {}) =>
    item({ itemCode, label, section: "J", group: "Symptom Follow-Up Visit", ...extra });
  const sections = [
    ...(options.withAdministrative
      ? [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({ itemCode: "A0500A", label: "First name", state: "answered", value: "Ada" }),
            ],
          },
        ]
      : []),
    {
      code: "J",
      label: "Health Conditions",
      items: [
        sfvItem(
          "J2052A",
          "SFV completed",
          options.recorded ? { state: "answered", value: "1" } : {},
        ),
        sfvItem("J2053A", "Impact of pain"),
        sfvItem("J2053B", "Impact of shortness of breath"),
      ],
    },
  ];
  return workspace({ sections });
}

// ---- the follow-up (SFV) scenarios shared by the workspace tests --------------------------------------------------

export const SFV_QUEUE = "/api/v1/hope/sfv";
export const SIGNED = { ...assessment, status: "signed", signedAt: "2026-09-08T14:00:00.000Z" };
export const row = (
  status: string,
  triggeringAssessmentId = "hope-1",
  completingAssessmentId: string | null = null,
) => ({
  id: "sfv-1",
  triggeringAssessmentId,
  admissionId: "adm-1",
  patientId: "patient-1",
  status,
  completingAssessmentId,
});
export const COULD_NOT_CHECK = "Could not check the follow-up visit status.";
export const SIGNED_NOTE =
  "This record is signed; the follow-up visit cannot be completed from it.";
export const COMPLETED_NOTE = "The follow-up visit was completed after this record was signed.";
export const completeSfvButton = () => screen.queryByRole("button", { name: "Complete SFV" });
export const sfvLookups = (client: ApiClient) =>
  vi
    .mocked(client.GET as unknown as (path: string) => unknown)
    .mock.calls.filter(([path]) => path === SFV_QUEUE);

/** Answer every question in the open dialog, attest, and press its Complete SFV button. */
export function completeInDialog(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
  for (const none of within(dialog).getAllByRole("radio", { name: "Not at all" }))
    fireEvent.click(none);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Complete SFV" }));
}
