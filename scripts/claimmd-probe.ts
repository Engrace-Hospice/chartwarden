// scripts/claimmd-probe.ts — closes the open rows of the Claim.MD contract doc against a Claim.MD TEST account
// (docs/audits/clearinghouse-integration/CLAIMMD_TRANSPORT_CONTRACT_20261104.md, "Still open").
//
//   CLAIMMD_ACCOUNT_USAGE=test CLAIMMD_ACCOUNT_NUMBER=<account #> bun --env-file=.env scripts/claimmd-probe.ts
//
// 1. NOE (TOB 81A) and NOTR (81B) through ClaimMdTransport.submitNotice, then their acknowledgments (G1).
// 2. The SAME 837I file uploaded twice under the same Filename: does Claim.MD refuse, dedupe or duplicate it (G4)?
// 3. `/uploadlist/` for a day with no uploads and for today: the empty-day shape the reconciliation needs.
// 4. `/eralist/` and `/era835/`: the remittance shapes (the test payer may or may not have produced an ERA yet), for
//    up to 5 ERAs. `PROBE_STEPS=era` runs this step alone (no uploads):
//    CLAIMMD_ACCOUNT_USAGE=test CLAIMMD_ACCOUNT_NUMBER=<account #> PROBE_STEPS=era bun --env-file=.env scripts/claimmd-probe.ts
// Everything is synthetic (Claim.MD's sample provider, a synthetic MBI); the key is masked from every printed answer.
import {
  ClaimMdTransport,
  InMemoryAttemptStore,
  type NoticeDocument,
  build837iClaim,
  build837iNotice,
} from "@chartwarden/x12-837-client";

const key = process.env.CLAIMMD_ACCOUNT_KEY?.trim() ?? "";
const usage = process.env.CLAIMMD_ACCOUNT_USAGE?.trim();
const account = process.env.CLAIMMD_ACCOUNT_NUMBER?.trim() ?? "";
if (!key || usage !== "test" || !/^\d{1,15}$/.test(account)) {
  console.error(
    "Set CLAIMMD_ACCOUNT_KEY (quoted), CLAIMMD_ACCOUNT_USAGE=test and CLAIMMD_ACCOUNT_NUMBER. Test accounts only.",
  );
  process.exit(2);
}

const BASE = "https://svc.claim.md/services";
const SAMPLE_NPI = "1111111112";
const PAYER = { name: "HHH MEDICARE J15", payerId: "15004" };
const POLLS = 9;
const POLL_INTERVAL_MS = 20_000;
const PRINT_LIMIT = 700;
/** How many ERAs step 4 downloads (each is one request against Claim.MD's 100-a-minute limit). */
const ERA_PROBE_LIMIT = 5;
const runId = Date.now().toString(36).toUpperCase();
let interchange = Date.now() % 900_000_000;

/** One raw Claim.MD call; the answer text with the key masked. */
async function raw(
  path: string,
  fields: Record<string, string> | FormData,
): Promise<{ status: number; text: string }> {
  let body: URLSearchParams | FormData;
  if (fields instanceof FormData) {
    fields.set("AccountKey", key);
    body = fields;
  } else {
    body = new URLSearchParams({ AccountKey: key, ...fields });
  }
  const res = await fetch(`${BASE}/${path}/`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
    redirect: "error",
  });
  return { status: res.status, text: (await res.text()).split(key).join("<key>") };
}
const show = (label: string, r: { status: number; text: string }): void =>
  console.log(`${label}: HTTP ${r.status} ${r.text.slice(0, PRINT_LIMIT)}`);

const parties = {
  submitter: {
    name: "ChartWarden Sandbox",
    id: account,
    contactName: "Billing Office",
    contactPhone: "5035550100",
  },
  receiver: { name: "CLAIM.MD", id: "CLAIMMD" },
  billingProvider: {
    organizationName: "Sample Practice",
    npi: SAMPLE_NPI,
    taxId: "999999999",
    address: { line1: "100 Main St", city: "Portland", state: "OR", postalCode: "97201-1234" },
  },
  subscriber: {
    lastName: "Doe",
    firstName: "Jane",
    mbi: "1EG4TE5MK73",
    address: { line1: "200 Oak Ave", city: "Salem", state: "OR", postalCode: "97301" },
    birthDate: "1940-03-15",
    sex: "F" as const,
  },
  payer: PAYER,
};
const envelope = () => ({
  senderId: account,
  receiverId: "CLAIMMD",
  applicationReceiverCode: "CLAIMMD",
  interchangeControlNumber: ++interchange,
  usage: "T" as const,
  createdAt: new Date(),
});
const physician = { lastName: "Smith", firstName: "Alan", npi: "1245319599" };

const ctx = {
  organizationId: "sandbox-org",
  providerEntityId: "sandbox-pe",
  payerId: PAYER.payerId,
  correlationId: `probe-${runId}`,
  usage: "test" as const,
  billingNpi: SAMPLE_NPI,
};
const transport = new ClaimMdTransport({
  keys: { test: key },
  attempts: new InMemoryAttemptStore(),
  onAnomaly: (a) => console.log("anomaly", JSON.stringify(a)),
});

if (process.env.PROBE_STEPS?.trim() === "era") {
  await probeEras();
  process.exit(0);
}

// ── 1. NOE and NOTR ──────────────────────────────────────────────────────────────────────────────────
const notices: { kind: "noe" | "notr"; doc: NoticeDocument }[] = [
  {
    kind: "noe",
    doc: { kind: "NOE", controlNumber: `CWPRB${runId}E`, admissionDate: "2026-10-01" },
  },
  {
    kind: "notr",
    doc: {
      kind: "NOTR",
      controlNumber: `CWPRB${runId}T`,
      admissionDate: "2026-10-01",
      terminationDate: "2026-10-31",
    },
  },
];
for (const n of notices) {
  const x12 = build837iNotice({
    ...parties,
    envelope: envelope(),
    notice: n.doc,
    principalDiagnosis: "C34.90",
    attendingPhysician: physician,
  });
  const r = await transport.submitNotice(ctx, {
    kind: n.kind,
    controlNumber: n.doc.controlNumber,
    idempotencyKey: `probe-${n.doc.controlNumber}`,
    payload: { format: "x12", x12 },
  });
  console.log(`notice ${n.kind} ${n.doc.controlNumber}:`, JSON.stringify(r));
}

// ── 2. The same file twice, same Filename ─────────────────────────────────────────────────────────────
const dupControl = `CWPRB${runId}D`;
const dupX12 = build837iClaim({
  ...parties,
  attendingPhysician: physician,
  envelope: envelope(),
  claim: {
    controlNumber: dupControl,
    frequency: "2",
    statementFromDate: "2026-10-01",
    statementThroughDate: "2026-10-31",
    admissionDate: "2026-10-01",
    admissionTypeCode: "1",
    admissionSource: "1",
    patientStatus: "30",
    principalDiagnosis: "C34.90",
    otherDiagnoses: [],
    conditionCodes: [],
    occurrenceCodes: [{ code: "27", date: "2026-10-01" }],
    valueCodes: [{ code: "61", amount: "38900" }],
    lines: [
      {
        revenueCode: "0651",
        hcpcs: "Q5001",
        chargeCents: 20000,
        units: 1,
        serviceDate: "2026-10-01",
      },
    ],
  },
});
const dupName = `cw-probe-${runId.toLowerCase()}.837`;
for (const attempt of [1, 2]) {
  const form = new FormData();
  form.set("Filename", dupName);
  form.set("File", new Blob([dupX12], { type: "text/plain" }), dupName);
  show(`duplicate upload ${attempt}`, await raw("upload", form));
}

// ── 3. The upload list: an empty day, then today ─────────────────────────────────────────────────────
show(
  "uploadlist empty day 2020-01-01",
  await raw("uploadlist", { UploadDate: "2020-01-01", Page: "1" }),
);
const today = new Date().toISOString().slice(0, 10);
const listed = await raw("uploadlist", { UploadDate: today, Page: "1" });
show(`uploadlist ${today}`, listed);
console.log(
  `uploadlist ${today}: our duplicate name appears ${listed.text.split(dupName).length - 1} time(s)`,
);

// ── Acknowledgments for the notices and the duplicate ───────────────────────────────────────────────
const mine = new Set([...notices.map((n) => n.doc.controlNumber), dupControl]);
let cursor: string | null = null;
for (let poll = 1; poll <= POLLS; poll++) {
  const page = await transport.fetchAcknowledgments(ctx, cursor);
  if (!page.ok) {
    console.log(`poll ${poll}:`, JSON.stringify(page.degraded));
  } else {
    for (const ack of page.data.items.filter((a) => mine.has(a.controlNumber))) {
      console.log(`poll ${poll} ack:`, JSON.stringify(ack));
    }
    cursor = page.data.nextCursor;
  }
  if (poll < POLLS) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
const stream = await raw("response", { ResponseID: "0" });
let entries: Record<string, unknown>[] = [];
try {
  const body = JSON.parse(stream.text) as { claim?: unknown };
  entries = (Array.isArray(body.claim) ? body.claim : body.claim ? [body.claim] : []) as Record<
    string,
    unknown
  >[];
} catch {
  console.log("response stream: unparseable");
}
for (const c of entries.filter((e) => mine.has(String(e.pcn)))) {
  const messages = (Array.isArray(c.messages) ? c.messages : [c.messages]).filter(
    Boolean,
  ) as Record<string, unknown>[];
  console.log(
    "raw",
    JSON.stringify({
      pcn: c.pcn,
      claimid: c.claimid,
      status: c.status,
      senderid: c.senderid,
      sender_name: c.sender_name,
      messages: messages.map((m) => ({ status: m.status, mesgid: m.mesgid, message: m.message })),
    }),
  );
}
const dupIds = new Set(entries.filter((e) => e.pcn === dupControl).map((e) => e.claimid));
console.log(`duplicate ${dupControl}: ${dupIds.size} distinct claim id(s) in the response stream`);

await probeEras();

// ── 4. Remittance shapes (alone with PROBE_STEPS=era) ────────────────────────────────────────────────
async function probeEras(): Promise<void> {
  const eras = await raw("eralist", { ERAID: "0", NPI: SAMPLE_NPI, NewOnly: "0" });
  show("eralist", eras);
  const ids = [
    ...new Set([...eras.text.matchAll(/"eraid"\s*:\s*"?(\d+)/g)].map((m) => m[1] as string)),
  ];
  if (ids.length === 0) {
    console.log(
      "era835: no ERA on the account yet (the test payer may produce one later; re-run step 4 then)",
    );
    return;
  }
  for (const eraid of ids.slice(0, ERA_PROBE_LIMIT)) {
    const era = await raw("era835", { eraid });
    let keys = "unparseable";
    let shape = "unknown";
    try {
      const body = JSON.parse(era.text) as Record<string, unknown>;
      keys = Object.keys(body).join(",");
      const d = body.data;
      // Lengths and envelope flags only, never content: what the adapter's split/join rule (claimmd-wire rawFiles) sees.
      const describe = (x: unknown): string =>
        typeof x === "string"
          ? `${x.length} chars, ISA ${x.trimStart().startsWith("ISA")}, IEA ${/IEA\*[^~]*~?\s*$/.test(x)}`
          : typeof x;
      shape = Array.isArray(d) ? `array of ${d.length}: ${d.map(describe).join(" | ")}` : typeof d;
    } catch {
      // keep "unparseable"
    }
    console.log(`era835 ${eraid}: HTTP ${era.status}, top-level keys ${keys}, data ${shape}`);
  }
  console.log(`era835: probed ${Math.min(ids.length, ERA_PROBE_LIMIT)} of ${ids.length} ERA(s)`);
}
