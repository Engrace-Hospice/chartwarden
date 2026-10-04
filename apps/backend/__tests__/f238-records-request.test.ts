// apps/backend/__tests__/f238-records-request.test.ts — F-238 step 4: requesting a prospect's older records.
//
// 1. The code + matcher (pure, @wardenx/intake-extraction): the alphabet has none of the characters OCR
//    swaps, a check character catches every single misread, OCR confusions on the page are folded back,
//    and ordinary clinical text ("RR 18", "CORRECT", "ERRATA") never yields a code.
// 2. The cover sheet: the code large and in the instructions, the prospect's name + DOB only, escaped.
// 3. The routes over the in-memory service through the FULL M1 chain (RBAC on the intake keys, referral
//    visibility through the M6 seam, 404 for another org), and the manual `recordsRequestId` link on
//    POST /intake/uploads (filed under the request's referral; a different referral or a cancelled
//    request is refused).
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import {
  RECORDS_REQUEST_ALPHABET,
  findRecordsRequestCodes,
  generateRecordsRequestCode,
  isValidRecordsRequestCode,
  normaliseRecordsRequestCode,
  recordsRequestCheckChar,
} from "@wardenx/intake-extraction";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  COVER_SHEET_CODE_SIZE,
  type OutboundFaxTransport,
  createInMemoryDocumentBackend,
  createInMemoryRecordsRequestFaxStore,
  createInMemoryRecordsRequestService,
  createSignedUrlService,
  createStubOutboundFaxTransport,
  createUnconfiguredOutboundFaxTransport,
  normaliseFaxNumber,
  registerDocumentRoutes,
  registerRecordsRequestRoutes,
  renderRecordsRequestCoverSheetPdf,
  selectOutboundFaxTransport,
} from "../src/modules/22-documents/index";

// ── 1. code + matcher ────────────────────────────────────────────────────────────────────────────────

/** Deterministic byte source for the generator. */
const bytes = (seed: number) => {
  let x = seed;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out[i] = x & 0xff;
    }
    return out;
  };
};
const code = (payload: string) => `RR-${payload}${recordsRequestCheckChar(payload)}`;

describe("F-238 — the records-request code", () => {
  it("the alphabet contains none of the characters OCR confuses (O/0/Q, I/1/L, S/5, B/8, U, Z, G)", () => {
    for (const c of "O0QI1LS5B8UZG") expect(RECORDS_REQUEST_ALPHABET).not.toContain(c);
    expect(RECORDS_REQUEST_ALPHABET).toHaveLength(23);
  });

  it("generated codes are well-formed and verify", () => {
    const gen = bytes(42);
    for (let i = 0; i < 200; i++) {
      const c = generateRecordsRequestCode(gen);
      expect(c).toMatch(/^RR-[ACDEFHJKMNPRTVWXY234679]{7}$/);
      expect(isValidRecordsRequestCode(c)).toBe(true);
    }
  });

  it("every single-character substitution and every adjacent transposition is detected", () => {
    const valid = code("7KHM3X");
    const body = valid.slice(3);
    for (let i = 0; i < body.length; i++) {
      for (const ch of RECORDS_REQUEST_ALPHABET) {
        if (ch === body[i]) continue;
        const bad = `RR-${body.slice(0, i)}${ch}${body.slice(i + 1)}`;
        expect(isValidRecordsRequestCode(bad), bad).toBe(false);
      }
      if (i < body.length - 1 && body[i] !== body[i + 1]) {
        const sw = `RR-${body.slice(0, i)}${body[i + 1]}${body[i]}${body.slice(i + 2)}`;
        expect(isValidRecordsRequestCode(sw), sw).toBe(false);
      }
    }
  });

  it("finds a cleanly printed code on a fax page", () => {
    const c = code("7KHM3X");
    const page = `FAX COVER\nRe: records request\nRequest code\n${c}\nPlease include this cover sheet`;
    expect(findRecordsRequestCodes(page)).toEqual([c]);
  });

  it("folds OCR confusions back onto the alphabet (D→0/O, T→1, 3→8, 9→S, 2→Z, 6→G)", () => {
    const c = code("DT3926");
    const body = c.slice(3);
    // What a degraded fax OCR might read: D as 0, T as 1, 3 as 8, 9 as S, 2 as Z, 6 as G (max 3 at a time).
    const reads = [
      `RR-0${body.slice(1)}`,
      `RR-${body[0]}1${body.slice(2)}`,
      `RR-${body.slice(0, 2)}8${body.slice(3)}`,
      `RR-${body.slice(0, 3)}S${body.slice(4)}`,
      `RR-${body.slice(0, 4)}Z${body.slice(5)}`,
      `RR-${body.slice(0, 5)}G${body.slice(6)}`,
      `RR-O1B${body.slice(3)}`,
    ];
    for (const r of reads) expect(findRecordsRequestCodes(`Code: ${r}`), r).toContain(c);
  });

  it("tolerates lower case, a missing or odd dash, an e-mail subject and a fax header around it", () => {
    const c = code("PWNC4E");
    const b = c.slice(3);
    expect(findRecordsRequestCodes(`Re: Records for J. Doe — rr-${b.toLowerCase()}`)).toEqual([c]);
    expect(findRecordsRequestCodes(`RR ${b}`)).toEqual([c]);
    expect(findRecordsRequestCodes(`RR—${b}.`)).toEqual([c]);
    expect(findRecordsRequestCodes(`(RR:${b})`)).toEqual([c]);
  });

  it("ordinary clinical text never yields a code (false-positive resistance)", () => {
    const text = [
      "Vitals: BP 128/76, HR 88, RR 18, SpO2 94% on RA.",
      "RR: 22 bpm, labored. RR 20/min at rest.",
      "CORRECTION: ERRATA noted; the prior report was incorrect.",
      "Patient referred for hospice evaluation. Narrative: progressive CHF, NYHA class IV.",
      "RRT called 10/02. RR-interval irregular on telemetry.",
      "MRN RR12345678 ACCT 99887766",
      "RR ACCEPTS DIET",
    ].join("\n");
    expect(findRecordsRequestCodes(text)).toEqual([]);
  });

  it("a code-shaped token whose check character fails is not a code", () => {
    const c = code("7KHM3X");
    const wrongCheck = RECORDS_REQUEST_ALPHABET.split("").find((x) => x !== c[9]) as string;
    expect(findRecordsRequestCodes(`RR-${c.slice(3, 9)}${wrongCheck}`)).toEqual([]);
  });

  it("does not anchor on RR inside a word, or on a code glued to more characters", () => {
    const c = code("7KHM3X");
    expect(findRecordsRequestCodes(`ERR-${c.slice(3)}`)).toEqual([]);
    expect(findRecordsRequestCodes(`${c}9`)).toEqual([]);
  });

  it("normalises a code a person typed", () => {
    const c = code("7KHM3X");
    expect(normaliseRecordsRequestCode(` rr ${c.slice(3).toLowerCase()} `)).toBe(c);
    expect(normaliseRecordsRequestCode("RR-AAAAAAA")).toBe(
      isValidRecordsRequestCode("RR-AAAAAAA") ? "RR-AAAAAAA" : null,
    );
    expect(normaliseRecordsRequestCode("hello")).toBeNull();
  });
});

// ── 2. cover sheet ───────────────────────────────────────────────────────────────────────────────────

/** Every content stream of a PDF from the M22 writer (uncompressed, one stream per page). */
function pdfStreams(bytes: Uint8Array | Buffer): string[] {
  const text = Buffer.from(bytes).toString("latin1");
  return [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1] as string);
}
/** The text a reader (or OCR of the rendering) sees: every `( … ) Tj` string, one per line, unescaped. */
function pdfText(stream: string): string {
  return [...stream.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) =>
      (m[1] as string).replace(/\\([0-7]{3}|.)/g, (_x, e: string) =>
        e.length === 3 ? String.fromCharCode(Number.parseInt(e, 8)) : e,
      ),
    )
    .join("\n");
}

describe("F-238 — the cover sheet (PDF)", () => {
  const view = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    referralId: "66666666-6666-4666-8666-666666666666",
    patientId: null,
    requestCode: code("7KHM3X"),
    recipientName: "Dr. (Jane) Pell \\ records",
    recipientOrganization: "Riverbend Family Medicine",
    recipientFax: "(503) 555-0100",
    recipientEmail: "records@riverbend.example",
    recordsRequested: ["history_and_physical", "labs"] as const,
    recordsRequestedNote: "Oncology notes since 2025",
    dateRangeStart: "2025-01-01",
    dateRangeEnd: null,
    status: "requested" as const,
    dueDate: "2026-10-11",
    overdue: false,
    expiresOn: null,
    expiredAt: null,
    receivedAfterExpiry: false,
    requestedByMembershipId: "m",
    requestedAt: "2026-10-04T12:00:00.000Z",
    receivedAt: null,
    cancelledAt: null,
    batches: 0,
  };
  const render = () =>
    renderRecordsRequestCoverSheetPdf(
      { ...view, recordsRequested: [...view.recordsRequested] },
      { displayName: "DOCLENS, ARTHUR", dateOfBirth: "1941-03-02" },
      { fromOrganization: "Engrace Hospice" },
    );
  const pdf = render();
  const raw = Buffer.from(pdf.bytes).toString("latin1");
  const [cover, ...letter] = pdfStreams(pdf.bytes);
  const coverText = pdfText(cover as string);
  const letterText = letter.map(pdfText).join("\n");

  it("is a real, deterministic PDF: cover page + letter, named after the code, hashed", () => {
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf.pageCount).toBe(2);
    expect(raw).toContain("/Count 2");
    expect(pdf.filename).toBe(`records-request-${view.requestCode}.pdf`);
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    // No wall clock: the same request renders the same bytes (the fax row's sha256 proves what went out).
    expect(Buffer.from(render().bytes).equals(Buffer.from(pdf.bytes))).toBe(true);
  });

  it("prints the code LARGE on the cover page, and the matcher finds exactly that code in its text", () => {
    expect(cover).toMatch(
      new RegExp(`/F2 ${COVER_SHEET_CODE_SIZE} Tf [^\\n]*\\(${view.requestCode}\\) Tj`),
    );
    expect(COVER_SHEET_CODE_SIZE).toBeGreaterThanOrEqual(36);
    // What OCR of the rendered cover page reads is its text: the inbound matcher must file it by that code.
    expect(findRecordsRequestCodes(coverText)).toEqual([view.requestCode]);
    expect(findRecordsRequestCodes(letterText)).toEqual([view.requestCode]);
    expect(coverText).toContain(`or put ${view.requestCode} in your email subject.`);
    expect(coverText).toContain("2 (including this cover sheet)");
    expect(coverText).toContain("Engrace Hospice");
  });

  it("minimum necessary: the prospect only on the letter (name + DOB), never on the cover page; no ids, no email", () => {
    expect(coverText).not.toContain("DOCLENS");
    expect(coverText).not.toContain("03/02/1941");
    expect(letterText).toContain("DOCLENS, ARTHUR");
    expect(letterText).toContain("03/02/1941");
    for (const s of [view.referralId, view.id, view.recipientEmail as string]) {
      expect(raw).not.toContain(s);
    }
  });

  it("lists what is requested and escapes PDF string delimiters", () => {
    expect(letterText).toContain("History & physical (H&P)");
    expect(letterText).toContain("Laboratory results");
    expect(letterText).toContain("Oncology notes since 2025");
    expect(letterText).toContain("01/01/2025 to present");
    expect(letterText).toContain("Please respond by 10/11/2026.");
    expect(coverText).toContain("Dr. (Jane) Pell \\ records");
    expect(raw).toContain("Dr. \\(Jane\\) Pell \\\\ records");
  });
});

describe("F-238 — fax number normalisation + transport selection", () => {
  it("normalises NANP and E.164 numbers; refuses what a fax machine cannot dial", () => {
    expect(normaliseFaxNumber("(503) 555-0100")).toBe("+15035550100");
    expect(normaliseFaxNumber("503.555.0100")).toBe("+15035550100");
    expect(normaliseFaxNumber("1 503 555 0100")).toBe("+15035550100");
    expect(normaliseFaxNumber("+1 (503) 555-0100")).toBe("+15035550100");
    expect(normaliseFaxNumber("+44 20 7946 0958")).toBe("+442079460958");
    for (const bad of [
      "555-0100", // 7 digits
      "(103) 555-0100", // area code starts with 1
      "(503) 155-0100", // exchange starts with 1
      "(911) 555-0100", // N11
      "+0 123 456 789",
      "503-555-0100 x12",
      "+1234567890123456", // > 15 digits
      "fax me",
    ]) {
      expect(normaliseFaxNumber(bad), bad).toBeNull();
    }
  });

  it("selects the stub in development, refuses the stub in production, and never fakes an unknown provider", () => {
    const quiet = () => {};
    expect(selectOutboundFaxTransport({ isProduction: false, env: {}, log: quiet })).toMatchObject({
      provider: "stub",
      available: true,
    });
    expect(selectOutboundFaxTransport({ isProduction: true, env: {} }).available).toBe(false);
    expect(
      selectOutboundFaxTransport({ isProduction: true, env: { FAX_PROVIDER: "stub" } }).available,
    ).toBe(false);
    const unknown = selectOutboundFaxTransport({
      isProduction: false,
      env: { FAX_PROVIDER: "faxco" },
    });
    expect(unknown.available).toBe(false);
    expect(unknown.unavailableReason).toContain("faxco");
    const real = createStubOutboundFaxTransport({ log: quiet });
    expect(selectOutboundFaxTransport({ isProduction: true, env: {}, provider: real })).toBe(real);
  });

  it("the stub logs the masked number and the code — never the document or the full number", async () => {
    const lines: string[] = [];
    const t = createStubOutboundFaxTransport({ log: (l) => lines.push(l) });
    const res = await t.send({
      organizationId: "o",
      to: "+15035550100",
      documents: [
        { filename: "x.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
      ],
      reference: "RR-7KHM3XT",
      idempotencyKey: "k",
    });
    expect(res.ok).toBe(true);
    expect(t.sent).toHaveLength(1);
    expect(lines.join("\n")).toContain("***0100");
    expect(lines.join("\n")).not.toContain("5035550100");
  });
});

// ── 3. routes ────────────────────────────────────────────────────────────────────────────────────────

const ORG = "org_a";
const ORG_B = "org_b";
const REFERRAL = "66666666-6666-4666-8666-666666666666";
const OTHER_REFERRAL = "77777777-7777-4777-8777-777777777777";
const HIDDEN_REFERRAL = "88888888-8888-4888-8888-888888888888";
const PATIENT = "11111111-1111-4111-8111-111111111111";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["intake"];
}

const GRANTS: Record<string, string[]> = {
  intake_1: ["intake.upload", "intake.read"],
  reader_1: ["intake.read"],
  nobody_1: [],
};

function makeServer(opts: { transport?: OutboundFaxTransport } = {}) {
  const grantStore = createInMemoryEffectivePermissionStore(
    Object.entries(GRANTS).flatMap(([userId, permissionKeys]) =>
      [ORG, ORG_B].map((orgId) => ({
        orgId,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ),
  );
  registerEffectivePermissionResolver(grantStore.store);
  registerAbacRegistry();
  const service = createInMemoryRecordsRequestService({
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
  const subjects: Record<string, { patientId: string | null; name: string; dob: string | null }> = {
    [REFERRAL]: { patientId: null, name: "DOCLENS, ARTHUR", dob: "1941-03-02" },
    [OTHER_REFERRAL]: { patientId: PATIENT, name: "VANCE, ADA", dob: "1950-11-19" },
    [HIDDEN_REFERRAL]: { patientId: null, name: "HIDDEN, PERSON", dob: null },
  };
  const referralReader = {
    async canAccessReferral(i: { organizationId: string; referralId: string }) {
      return (
        i.organizationId === ORG && i.referralId !== HIDDEN_REFERRAL && !!subjects[i.referralId]
      );
    },
    async getReferralSubject(i: { organizationId: string; referralId: string }) {
      const s = i.organizationId === ORG ? subjects[i.referralId] : undefined;
      return s
        ? { patientId: s.patientId, patientNameAtReceipt: s.name, patientDobAtReceipt: s.dob }
        : null;
    },
  };
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const transport = opts.transport ?? createStubOutboundFaxTransport({ log: () => {} });
  const faxStore = createInMemoryRecordsRequestFaxStore({
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
  registerRecordsRequestRoutes(app, {
    service,
    referralReader,
    patientReader: async (_o, id) =>
      id === PATIENT ? { lastName: "Vance", firstName: "Ada", dateOfBirth: "1950-11-19" } : null,
    organizationName: async () => "Engrace Hospice",
    fax: { transport, store: faxStore },
  });
  const backend = createInMemoryDocumentBackend({});
  registerDocumentRoutes(app, {
    service: backend.service,
    signedUrl: createSignedUrlService({
      storage: {
        async presignDownload() {
          throw new Error("unused");
        },
      },
      resolver: backend.objectResolver,
    }),
    referralReader,
    recordsRequests: service,
  });
  return { app, service, transport, faxStore };
}

const H = (user: string, org = ORG) => ({ "x-test-user": user, "x-test-org": org });
const BODY = {
  recipientName: "Dr. Pell",
  recipientOrganization: "Riverbend Family Medicine",
  recipientFax: "(503) 555-0100",
  recordsRequested: ["history_and_physical", "discharge_summary"],
  dateRangeStart: "2025-01-01",
  dueDate: "2026-10-01",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("F-238 — records-request routes", () => {
  const create = (
    app: ReturnType<typeof makeServer>["app"],
    referral = REFERRAL,
    user = "intake_1",
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/referrals/${referral}/records-requests`,
      headers: H(user),
      payload: BODY,
    });

  it("creates a request with a valid code, bound to the referral (and its patient once resolved)", async () => {
    const { app } = makeServer();
    const res = await create(app);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(isValidRecordsRequestCode(body.requestCode)).toBe(true);
    expect(body).toMatchObject({
      referralId: REFERRAL,
      patientId: null,
      status: "requested",
      recipientName: "Dr. Pell",
      recordsRequested: ["history_and_physical", "discharge_summary"],
      // Due 2026-10-01, "today" 2026-10-04 and still awaiting → overdue (computed, status untouched).
      overdue: true,
    });
    const resolved = await create(app, OTHER_REFERRAL);
    expect(resolved.json().patientId).toBe(PATIENT);
  });

  it("refuses a request without fax or e-mail, or without anything requested (422)", async () => {
    const { app } = makeServer();
    const noChannel = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${REFERRAL}/records-requests`,
      headers: H("intake_1"),
      payload: { ...BODY, recipientFax: undefined },
    });
    expect(noChannel.statusCode).toBe(422);
    const nothing = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${REFERRAL}/records-requests`,
      headers: H("intake_1"),
      payload: { ...BODY, recordsRequested: [] },
    });
    expect(nothing.statusCode).toBe(422);
  });

  it("RBAC: creating needs intake.upload (403 for a reader); listing needs intake.read", async () => {
    const { app } = makeServer();
    expect((await create(app, REFERRAL, "reader_1")).statusCode).toBe(403);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/referrals/${REFERRAL}/records-requests`,
      headers: H("nobody_1"),
    });
    expect(list.statusCode).toBe(403);
  });

  it("a referral the caller cannot see, or another org's, is a non-leaking 404", async () => {
    const { app } = makeServer();
    expect((await create(app, HIDDEN_REFERRAL)).statusCode).toBe(404);
    const created = (await create(app)).json();
    const otherOrg = await app.inject({
      method: "GET",
      url: `/api/v1/referrals/${REFERRAL}/records-requests/${created.id}/cover-sheet`,
      headers: H("intake_1", ORG_B),
    });
    expect(otherOrg.statusCode).toBe(404);
  });

  it("lists the referral's requests; another referral's request is not reachable through this one", async () => {
    const { app } = makeServer();
    const a = (await create(app)).json();
    await create(app, OTHER_REFERRAL);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/referrals/${REFERRAL}/records-requests`,
      headers: H("reader_1"),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    const cross = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${OTHER_REFERRAL}/records-requests/${a.id}/cancel`,
      headers: H("intake_1"),
      payload: {},
    });
    expect(cross.statusCode).toBe(404);
  });

  it("cancels once (409 the second time); marks received / partially received", async () => {
    const { app } = makeServer();
    const a = (await create(app)).json();
    const cancel = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/referrals/${REFERRAL}/records-requests/${a.id}/cancel`,
        headers: H("intake_1"),
        payload: { reason: "patient declined" },
      });
    const first = await cancel();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "cancelled", overdue: false });
    expect((await cancel()).statusCode).toBe(409);

    const b = (await create(app)).json();
    const mark = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${REFERRAL}/records-requests/${b.id}/status`,
      headers: H("intake_1"),
      payload: { status: "partially_received" },
    });
    expect(mark.statusCode).toBe(200);
    expect(mark.json()).toMatchObject({ status: "partially_received" });
    expect(mark.json().receivedAt).toBeTruthy();
  });

  it("serves the cover sheet as a no-store PDF (inline, named after the code)", async () => {
    const { app } = makeServer();
    const a = (await create(app)).json();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/referrals/${REFERRAL}/records-requests/${a.id}/cover-sheet`,
      headers: H("reader_1"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      `inline; filename="records-request-${a.requestCode}.pdf"`,
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    const text = pdfStreams(res.rawPayload).map(pdfText).join("\n");
    expect(findRecordsRequestCodes(text)).toEqual([a.requestCode]);
    expect(text).toContain("DOCLENS, ARTHUR");
    expect(text).toContain("Engrace Hospice");
    // Resolved referral → the chart's legal name.
    const r = (await create(app, OTHER_REFERRAL)).json();
    const chart = await app.inject({
      method: "GET",
      url: `/api/v1/referrals/${OTHER_REFERRAL}/records-requests/${r.id}/cover-sheet`,
      headers: H("reader_1"),
    });
    const chartText = pdfStreams(chart.rawPayload).map(pdfText).join("\n");
    expect(chartText).toContain("Vance, Ada");
    expect(chartText).toContain("11/19/1950");
  });

  describe("send by fax (POST …/send-fax)", () => {
    const send = (
      app: ReturnType<typeof makeServer>["app"],
      requestId: string,
      faxNumber: string,
      user = "intake_1",
      referral = REFERRAL,
    ) =>
      app.inject({
        method: "POST",
        url: `/api/v1/referrals/${referral}/records-requests/${requestId}/send-fax`,
        headers: H(user),
        payload: { faxNumber },
      });

    it("faxes the cover-sheet PDF to the E.164 number, records the send, and shows it on the list", async () => {
      const transport = createStubOutboundFaxTransport({ log: () => {} });
      const { app } = makeServer({ transport });
      const a = (await create(app)).json();
      const res = await send(app, a.id, "(503) 555-0100");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.replayed).toBe(false);
      expect(body.fax).toMatchObject({
        recordsRequestId: a.id,
        faxNumber: "+15035550100",
        status: "sent",
        provider: "stub",
        pageCount: 2,
        failureReason: null,
      });
      expect(body.fax.providerMessageId).toMatch(/^stub-/);
      expect(transport.sent).toHaveLength(1);
      const out = transport.sent[0];
      expect(out?.to).toBe("+15035550100");
      expect(out?.reference).toBe(a.requestCode); // the vendor sees the code, not the patient
      expect(out?.idempotencyKey).toBe(body.fax.id);
      const doc = out?.documents[0];
      expect(doc?.contentType).toBe("application/pdf");
      const sentText = pdfStreams(doc?.bytes as Uint8Array).map(pdfText);
      expect(findRecordsRequestCodes(sentText[0] as string)).toEqual([a.requestCode]);
      expect(sentText[0]).toContain("(503) 555-0100");
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/referrals/${REFERRAL}/records-requests`,
        headers: H("reader_1"),
      });
      expect(list.json().items[0].fax).toMatchObject({ id: body.fax.id, status: "sent" });
    });

    it("is idempotent per request: the same number replays, a different number is refused (409)", async () => {
      const transport = createStubOutboundFaxTransport({ log: () => {} });
      const { app } = makeServer({ transport });
      const a = (await create(app)).json();
      const first = (await send(app, a.id, "503-555-0100")).json();
      const again = await send(app, a.id, "+1 503 555 0100");
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ replayed: true, fax: { id: first.fax.id } });
      const other = await send(app, a.id, "(503) 555-0199");
      expect(other.statusCode).toBe(409);
      expect(other.json().error.code).toBe("RECORDS_REQUEST_FAX_ALREADY_SENT");
      expect(transport.sent).toHaveLength(1);
    });

    it("records a provider refusal as a failed attempt, and a retry after it may send", async () => {
      let refuse = true;
      const transport = createStubOutboundFaxTransport({
        log: () => {},
        fail: () => (refuse ? "busy signal" : null),
      });
      const { app, faxStore } = makeServer({ transport });
      const a = (await create(app)).json();
      const failed = await send(app, a.id, "(503) 555-0100");
      expect(failed.statusCode).toBe(200);
      expect(failed.json().fax).toMatchObject({ status: "failed", failureReason: "busy signal" });
      refuse = false;
      const retried = await send(app, a.id, "(503) 555-0100");
      expect(retried.json()).toMatchObject({ replayed: false, fax: { status: "sent" } });
      expect(faxStore.rows.size).toBe(2);
    });

    it("a transport that throws is a failed attempt, not a stuck `sending` row", async () => {
      const transport: OutboundFaxTransport = {
        provider: "flaky",
        available: true,
        async send() {
          throw new TypeError("fetch failed: +15035550100");
        },
      };
      const { app } = makeServer({ transport });
      const a = (await create(app)).json();
      const res = await send(app, a.id, "(503) 555-0100");
      expect(res.json().fax).toMatchObject({
        status: "failed",
        failureReason: "provider error: TypeError",
      });
    });

    it("refuses an undialable number (422), a closed request (409), no provider (503), a reader (403), a hidden referral (404)", async () => {
      const { app } = makeServer();
      const a = (await create(app)).json();
      expect((await send(app, a.id, "555-0100")).statusCode).toBe(422);
      expect((await send(app, a.id, "(503) 555-0100", "reader_1")).statusCode).toBe(403);
      expect(
        (await send(app, a.id, "(503) 555-0100", "intake_1", HIDDEN_REFERRAL)).statusCode,
      ).toBe(404);
      await app.inject({
        method: "POST",
        url: `/api/v1/referrals/${REFERRAL}/records-requests/${a.id}/cancel`,
        headers: H("intake_1"),
        payload: {},
      });
      const closed = await send(app, a.id, "(503) 555-0100");
      expect(closed.statusCode).toBe(409);
      expect(closed.json().error.code).toBe("RECORDS_REQUEST_NOT_OPEN");

      const off = makeServer({
        transport: createUnconfiguredOutboundFaxTransport("no outbound fax provider is configured"),
      });
      const b = (await create(off.app)).json();
      expect((await send(off.app, b.id, "(503) 555-0100")).statusCode).toBe(503);
    });
  });

  describe("manual link at upload (POST /intake/uploads recordsRequestId)", () => {
    const upload = (app: ReturnType<typeof makeServer>["app"], body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/intake/uploads",
        headers: H("intake_1"),
        payload: { sourceChannel: "fax", ...body },
      });

    it("files the batch under the request's referral (and its resolved patient)", async () => {
      const { app } = makeServer();
      const r = (await create(app, OTHER_REFERRAL)).json();
      const res = await upload(app, { recordsRequestId: r.id });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        referralId: OTHER_REFERRAL,
        patientId: PATIENT,
        recordsRequestId: r.id,
      });
    });

    it("refuses a request for a different referral than the one named (409)", async () => {
      const { app } = makeServer();
      const r = (await create(app, OTHER_REFERRAL)).json();
      const res = await upload(app, { recordsRequestId: r.id, referralId: REFERRAL });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("RECORDS_REQUEST_REFERRAL_CONFLICT");
    });

    it("refuses a cancelled request (409) and an unknown / other-org one (404)", async () => {
      const { app } = makeServer();
      const r = (await create(app)).json();
      await app.inject({
        method: "POST",
        url: `/api/v1/referrals/${REFERRAL}/records-requests/${r.id}/cancel`,
        headers: H("intake_1"),
        payload: {},
      });
      const cancelled = await upload(app, { recordsRequestId: r.id });
      expect(cancelled.statusCode).toBe(409);
      expect(cancelled.json().error.code).toBe("RECORDS_REQUEST_CANCELLED");
      const live = (await create(app)).json();
      const otherOrg = await app.inject({
        method: "POST",
        url: "/api/v1/intake/uploads",
        headers: H("intake_1", ORG_B),
        payload: { sourceChannel: "fax", recordsRequestId: live.id },
      });
      expect(otherOrg.statusCode).toBe(404);
    });
  });
});
