// Test kit for the two review panels (the field-task panel and the safeguard panel): a synthetic
// workspace, a fake review server (decisions, Part 2 / SUD and identity writes, page-image probes)
// whose answers each test picks, and harnesses that render a panel the way the workspace does.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import { useState } from "react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { type Mock, vi } from "vitest";
import type { Candidate, PlatformSupportAccess, Workspace } from "../doclens-api";
import { ReviewSafeguardPanel } from "./review-safeguard-panel";
import { ReviewSourcePanel } from "./review-source-panel";
import type { SourceZoom } from "./source-viewer";

export const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const CANDIDATE_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const SECOND_CANDIDATE_ID = "dddddddd-4444-4444-8444-dddddddddddd";
export const NATURAL_WIDTH = 1224;
export const SUPPORT_ACCESS: PlatformSupportAccess = {
  organizationId: "cccccccc-3333-4333-8333-cccccccccccc",
  supportSessionId: "support-session-1",
};

type Decision = NonNullable<Candidate["decision"]>;
type Document = Workspace["documents"][number];
type Review = Workspace["review"];

export const OWN_REVIEW: NonNullable<Review> = {
  id: "review-1",
  status: "in_progress",
  reviewerMembershipId: "membership-1",
  isMine: true,
};

export function savedDecision(
  kind: Decision["decision"],
  editedValue: string | null = null,
): Decision {
  return {
    id: "decision-1",
    decision: kind,
    editedValue,
    reason: null,
    partOfBulkApprove: false,
    decidedAt: "2026-11-22T11:00:00.000Z",
  };
}

export function candidateFixture(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    jobId: "job-1",
    documentType: "discharge_summary",
    fieldPath: "patient.address.city",
    description: "city",
    riskLevel: "low",
    confidence: 0.95,
    value: "Salem",
    page: 1,
    bbox: [61.2, 79.2, 306, 118.8],
    vision: { status: "not_required", observedValue: null },
    sudDetected: false,
    codingFlags: [],
    writebackTarget: true,
    redacted: false,
    decision: null,
    ...overrides,
  };
}

export function documentNeedingIdentity(pageFrom: number): Document {
  return {
    pageFrom,
    pageTo: pageFrom,
    documentType: "discharge_summary",
    title: "Discharge summary",
    date: null,
    duplicateOfPage: null,
    boundary: null,
    identity: { status: "mismatch", disagreeing: [], resolution: null },
  };
}

export function workspaceFixture(
  candidates: readonly Candidate[] = [candidateFixture(CANDIDATE_ID)],
  overrides: Partial<Workspace> = {},
): Workspace {
  const pages = [1, 2, 3].map((page) => ({
    page,
    width: 612,
    height: 792,
    documentType: "discharge_summary" as const,
    confidence: 0.98,
    needsHumanClassification: false,
  }));
  return {
    batch: {
      id: BATCH,
      status: "in_review",
      sourceChannel: "fax",
      uploadedAt: "2026-11-22T10:00:00.000Z",
      documentId: "document-1",
      patientId: "patient-1",
      patientName: "Synthetic Patient",
      referralId: null,
      identityStatus: "match",
      recordsRequestConflict: null,
    },
    sud: {
      status: "not_detected",
      detectorRef: null,
      resolvedAt: null,
      resolvedByMembershipId: null,
      contentRedacted: false,
      indicators: [],
    },
    pages,
    documents: [],
    jobs: [],
    review: OWN_REVIEW,
    candidates: [...candidates],
    ...overrides,
  };
}

export function sudWorkspace(overrides: Partial<Workspace["sud"]> = {}): Workspace {
  const base = workspaceFixture();
  return {
    ...base,
    sud: {
      ...base.sud,
      status: "detected",
      indicators: [
        {
          page: 2,
          category: "sud",
          ruleId: "synthetic-rule",
          term: "synthetic term",
          bbox: [61.2, 79.2, 306, 118.8],
        },
      ],
      ...overrides,
    },
  };
}

/** How the fake server answers one request: fine, no response at all (the client rethrows), or a refusal. */
export type Answer = "ok" | "network" | { readonly status: number; readonly message?: string };
export type ProbeAnswer = number | "network" | "pending";
export type RefreshAnswer = "ok" | "null" | "throw";

export interface PanelServer {
  workspace: Workspace;
  answers: {
    decision: Answer;
    sud: Answer;
    identity: Answer;
    probe: ProbeAnswer;
    refresh: RefreshAnswer;
  };
  requests: {
    decisions: { candidateId: string; decision: string; editedValue?: string; reason?: string }[];
    sud: { outcome: string; reason?: string }[];
    identity: { pageFrom: number; resolution: string; reason: string }[];
    probes: { url: string; method: string }[];
  };
  fetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  /** Answers every probe that is waiting (`answers.probe` was "pending"). */
  releaseProbes: (status: number) => void;
}

function refusal(answer: Exclude<Answer, "ok" | "network">): Response {
  return new Response(
    JSON.stringify({ error: { code: "REFUSED", message: answer.message ?? "Refused" } }),
    { status: answer.status, headers: { "content-type": "application/json" } },
  );
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function createPanelServer(initial: Workspace): PanelServer {
  const waiting: ((response: Response) => void)[] = [];
  const server: PanelServer = {
    workspace: initial,
    answers: { decision: "ok", sud: "ok", identity: "ok", probe: 200, refresh: "ok" },
    requests: { decisions: [], sud: [], identity: [], probes: [] },
    releaseProbes: (status) => {
      for (const release of waiting.splice(0)) release(new Response(null, { status }));
    },
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(String(input), "http://localhost").toString(), init);
      const path = new URL(request.url).pathname;
      if (request.method === "POST") return answerWrite(server, path, request);
      server.requests.probes.push({ url: request.url, method: request.method });
      const answer = server.answers.probe;
      if (answer === "network") throw new TypeError("Failed to fetch");
      if (answer === "pending")
        return await new Promise<Response>((resolve) => {
          waiting.push(resolve);
        });
      return new Response(null, { status: answer });
    }),
  };
  return server;
}

async function answerWrite(server: PanelServer, path: string, request: Request): Promise<Response> {
  const kind = path.endsWith("/decisions")
    ? "decision"
    : path.endsWith("/sud-review")
      ? "sud"
      : "identity";
  const answer = server.answers[kind];
  if (answer === "network") throw new TypeError("Failed to fetch");
  const body = (await request.clone().json()) as Record<string, unknown>;
  if (answer !== "ok") return refusal(answer);
  if (kind === "decision") return recordDecision(server, body);
  if (kind === "sud") return recordSud(server, body);
  return recordIdentity(server, body);
}

function recordDecision(server: PanelServer, body: Record<string, unknown>): Response {
  const saved = body as PanelServer["requests"]["decisions"][number];
  server.requests.decisions.push(saved);
  server.workspace = {
    ...server.workspace,
    candidates: server.workspace.candidates.map((candidate) =>
      candidate.id === saved.candidateId
        ? {
            ...candidate,
            decision: savedDecision(
              saved.decision as Decision["decision"],
              saved.editedValue ?? null,
            ),
          }
        : candidate,
    ),
  };
  return jsonOk({});
}

function recordSud(server: PanelServer, body: Record<string, unknown>): Response {
  const saved = body as PanelServer["requests"]["sud"][number];
  server.requests.sud.push(saved);
  const status = saved.outcome === "confirmed" ? "confirmed" : "rejected";
  server.workspace = { ...server.workspace, sud: { ...server.workspace.sud, status } };
  return jsonOk({ sudStatus: status });
}

function recordIdentity(server: PanelServer, body: Record<string, unknown>): Response {
  const saved = body as PanelServer["requests"]["identity"][number];
  server.requests.identity.push(saved);
  server.workspace = {
    ...server.workspace,
    documents: server.workspace.documents.map((document) =>
      document.pageFrom === saved.pageFrom
        ? {
            ...document,
            identity: {
              ...document.identity,
              resolution: saved.resolution as Document["identity"]["resolution"],
            },
          }
        : document,
    ),
  };
  return jsonOk({ identityStatus: "match" });
}

function Providers({
  server,
  children,
}: { server: PanelServer; children: JSX.Element }): JSX.Element {
  return (
    <ApiClientProvider
      client={createApiClient({ baseUrl: "http://localhost", fetch: server.fetch })}
    >
      <MemoryRouter>{children}</MemoryRouter>
    </ApiClientProvider>
  );
}

/** Stubs the global `fetch` (the page-image probe uses it) with the server's; restore with `vi.unstubAllGlobals`. */
export function stubServerFetch(server: PanelServer): void {
  vi.stubGlobal("fetch", server.fetch);
}

async function serverRefresh(
  server: PanelServer,
  setWorkspace: (workspace: Workspace) => void,
): Promise<Workspace | null> {
  if (server.answers.refresh === "throw") throw new TypeError("Failed to fetch");
  if (server.answers.refresh === "null") return null;
  setWorkspace(server.workspace);
  return server.workspace;
}

export interface SourcePanelProps {
  candidateId?: string;
  supportAccess?: PlatformSupportAccess | null;
  nextCandidate?: Candidate | null;
  zoom?: SourceZoom;
}

export interface SourcePanelSpies {
  onBusyChange: Mock<(busy: boolean) => void>;
  onAvailabilityChange: Mock<(page: number, unavailable: boolean) => void>;
  onDecisionSaved: Mock<(workspace: Workspace, candidateId: string) => void>;
  onZoomChange: Mock<(zoom: SourceZoom) => void>;
  onClose: Mock<() => void>;
  onNext: Mock<() => void>;
}

export function createSourcePanelSpies(): SourcePanelSpies {
  return {
    onBusyChange: vi.fn<(busy: boolean) => void>(),
    onAvailabilityChange: vi.fn<(page: number, unavailable: boolean) => void>(),
    onDecisionSaved: vi.fn<(workspace: Workspace, candidateId: string) => void>(),
    onZoomChange: vi.fn<(zoom: SourceZoom) => void>(),
    onClose: vi.fn<() => void>(),
    onNext: vi.fn<() => void>(),
  };
}

function SourcePanelHarness({
  server,
  spies,
  candidateId = CANDIDATE_ID,
  supportAccess = null,
  nextCandidate = null,
  zoom = "fit",
}: SourcePanelProps & { server: PanelServer; spies: SourcePanelSpies }): JSX.Element {
  const [workspace, setWorkspace] = useState(server.workspace);
  const candidate = workspace.candidates.find((item) => item.id === candidateId) as Candidate;
  return (
    <ReviewSourcePanel
      key={candidate.id}
      batchId={BATCH}
      workspace={workspace}
      candidate={candidate}
      returnTo={null}
      onClose={spies.onClose}
      onAvailabilityChange={spies.onAvailabilityChange}
      refresh={() => serverRefresh(server, setWorkspace)}
      onDecisionSaved={spies.onDecisionSaved}
      nextCandidate={nextCandidate}
      onNext={spies.onNext}
      supportAccess={supportAccess}
      onBusyChange={spies.onBusyChange}
      zoom={zoom}
      onZoomChange={spies.onZoomChange}
    />
  );
}

export function mountSourcePanel(
  server: PanelServer,
  props: SourcePanelProps = {},
): SourcePanelSpies & { rerender: (next: SourcePanelProps) => void } {
  stubServerFetch(server);
  const spies = createSourcePanelSpies();
  const view = render(
    <Providers server={server}>
      <SourcePanelHarness server={server} spies={spies} {...props} />
    </Providers>,
  );
  return {
    ...spies,
    rerender: (next) =>
      view.rerender(
        <Providers server={server}>
          <SourcePanelHarness server={server} spies={spies} {...next} />
        </Providers>,
      ),
  };
}

export interface SafeguardPanelProps {
  supportAccess?: PlatformSupportAccess | null;
  zoom?: SourceZoom;
  onZoomChange?: (zoom: SourceZoom) => void;
  selection?: Parameters<typeof ReviewSafeguardPanel>[0]["selection"];
  onBusyChange?: (busy: boolean) => void;
}

export function mountSafeguardPanel(
  server: PanelServer,
  props: SafeguardPanelProps = {},
): { onFocusBlock: Mock<Parameters<typeof ReviewSafeguardPanel>[0]["onFocusBlock"]> } {
  stubServerFetch(server);
  const onFocusBlock = vi.fn<Parameters<typeof ReviewSafeguardPanel>[0]["onFocusBlock"]>();
  function Harness(): JSX.Element {
    const [workspace, setWorkspace] = useState(server.workspace);
    return (
      <ReviewSafeguardPanel
        workspace={workspace}
        selection={props.selection ?? null}
        onFocusBlock={onFocusBlock}
        refresh={() => serverRefresh(server, setWorkspace)}
        supportAccess={props.supportAccess ?? null}
        zoom={props.zoom}
        onZoomChange={props.onZoomChange}
        onBusyChange={props.onBusyChange}
      />
    );
  }
  render(
    <Providers server={server}>
      <Harness />
    </Providers>,
  );
  return { onFocusBlock };
}
