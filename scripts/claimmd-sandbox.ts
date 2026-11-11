// scripts/claimmd-sandbox.ts — one synthetic run of the Claim.MD transport against a Claim.MD TEST account
// (ADR-0053 amendment 2026-11-04; results go into docs/audits/clearinghouse-integration/CLAIMMD_TRANSPORT_CONTRACT_20261104.md).
//
//   bun --env-file=.env scripts/claimmd-sandbox.ts
//
// Needs CLAIMMD_ACCOUNT_KEY, CLAIMMD_ACCOUNT_USAGE=test and CLAIMMD_ACCOUNT_NUMBER (the account # shown in the portal,
// used as ISA06/GS02). Refuses anything but a test account. Uploads two hospice 837I claims for Claim.MD's sample
// provider (NPI 1111111112): one plain, one with the documented test policy number REJECT. Then it polls /response/ for
// a few minutes and prints what came back: status letters, sender ids and message ids, which is the evidence the
// contract doc still lacks (G2). Every value is synthetic; the key is never printed.
import {
  type Claim837iInput,
  ClaimMdTransport,
  InMemoryAttemptStore,
  build837iClaim,
} from "@chartwarden/x12-837-client";

const key = process.env.CLAIMMD_ACCOUNT_KEY?.trim();
const usage = process.env.CLAIMMD_ACCOUNT_USAGE?.trim();
const account = process.env.CLAIMMD_ACCOUNT_NUMBER?.trim();
if (!key || usage !== "test" || !account || !/^\d{1,15}$/.test(account)) {
  console.error(
    "Set CLAIMMD_ACCOUNT_KEY, CLAIMMD_ACCOUNT_USAGE=test and CLAIMMD_ACCOUNT_NUMBER (digits). Test accounts only.",
  );
  process.exit(2);
}

// Preflight: the key's length and Claim.MD's raw answer (key masked), so a rejection says whether the key was cut short
// (an unquoted `#` in .env starts a comment) or refused whole. Never the key itself.
{
  const res = await fetch("https://svc.claim.md/services/response/", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({ AccountKey: key, ResponseID: "0" }),
    redirect: "error",
  });
  const text = (await res.text()).split(key).join("<key>");
  console.log(
    `preflight: key length ${key.length}, account prefix ok ${key.startsWith(`${account}_`)}, HTTP ${res.status}`,
  );
  // Printed either way: an empty account may answer with a "no data" error, which is evidence too.
  console.log("preflight answer:", text.slice(0, 300));
  if (/"error_code"\s*:\s*"21"/.test(text)) process.exit(1);
}

const SAMPLE_NPI = "1111111112";
const PAYER = { name: "HHH MEDICARE J15", payerId: "15004" };
const POLLS = 9;
const POLL_INTERVAL_MS = 20_000;

const runId = Date.now().toString(36).toUpperCase();
const input = (controlNumber: string, interchange: number): Claim837iInput => ({
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
    sex: "F",
  },
  payer: PAYER,
  attendingPhysician: { lastName: "Smith", firstName: "Alan", npi: "1245319599" },
  envelope: {
    senderId: account,
    receiverId: "CLAIMMD",
    applicationReceiverCode: "CLAIMMD",
    interchangeControlNumber: interchange,
    usage: "T",
    createdAt: new Date(),
  },
  claim: {
    controlNumber,
    // First interim claim of a continuing hospice stay (TOB 0812): the patient is still a patient (status 30).
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
    valueCodes: [
      { code: "61", amount: "38900" },
      { code: "G8", amount: "38900" },
    ],
    lines: [
      {
        revenueCode: "0651",
        hcpcs: "Q5001",
        chargeCents: 20000,
        units: 1,
        serviceDate: "2026-10-01",
      },
      {
        revenueCode: "0652",
        hcpcs: "Q5001",
        chargeCents: 80000,
        units: 32,
        serviceDate: "2026-10-02",
      },
    ],
  },
});

const ctx = {
  organizationId: "sandbox-org",
  providerEntityId: "sandbox-pe",
  payerId: PAYER.payerId,
  correlationId: `sandbox-${runId}`,
  usage: "test" as const,
  billingNpi: SAMPLE_NPI,
};
const transport = new ClaimMdTransport({
  keys: { test: key },
  attempts: new InMemoryAttemptStore(),
  onAnomaly: (a) => console.log("anomaly", JSON.stringify(a)),
});

const cases = [
  { label: "plain", controlNumber: `CWSBX${runId}A`, reject: false },
  { label: "REJECT policy", controlNumber: `CWSBX${runId}R`, reject: true },
];
for (const [i, c] of cases.entries()) {
  let x12 = build837iClaim(input(c.controlNumber, (Date.now() % 900_000_000) + i));
  // Claim.MD's documented test switch: policy (member) number REJECT forces a rejection.
  if (c.reject) x12 = x12.replace(/(NM1\*IL\*[^~]*\*MI\*)[^~*]+/, "$1REJECT");
  const r = await transport.submitClaim(ctx, {
    kind: "claim",
    controlNumber: c.controlNumber,
    idempotencyKey: `sandbox-${c.controlNumber}`,
    payload: { format: "x12", x12 },
  });
  console.log(`submit ${c.label} ${c.controlNumber}:`, JSON.stringify(r));
  if (!r.ok && r.degraded.code === "CH_NOT_WIRED") {
    console.error(
      "Claim.MD rejected the account key: copy the full key from Settings > Account Settings.",
    );
    process.exit(1);
  }
}

const mine = new Set(cases.map((c) => c.controlNumber));
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
  for (const c of cases) {
    const s = await transport.fetchClaimStatus(ctx, c.controlNumber);
    console.log(
      `poll ${poll} status ${c.label}:`,
      s.ok ? s.data.state : JSON.stringify(s.degraded),
    );
  }
  if (poll < POLLS) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

// The raw status vocabulary for the contract doc: letters, sender ids and message ids only, for our two claims.
const res = await fetch("https://svc.claim.md/services/response/", {
  method: "POST",
  headers: { Accept: "application/json" },
  body: new URLSearchParams({ AccountKey: key, ResponseID: "0" }),
  redirect: "error",
});
const raw = (await res.json().catch(() => null)) as {
  claim?: unknown;
  result?: { claim?: unknown };
} | null;
const listed = raw?.claim ?? raw?.result?.claim ?? [];
const claims = (Array.isArray(listed) ? listed : [listed]) as Record<string, unknown>[];
for (const c of claims.filter((x) => mine.has(String(x.pcn)))) {
  const messages = (Array.isArray(c.messages) ? c.messages : [c.messages]) as Record<
    string,
    unknown
  >[];
  console.log(
    "raw",
    JSON.stringify({
      pcn: c.pcn,
      status: c.status,
      senderid: c.senderid,
      sender_name: c.sender_name,
      messages: messages
        .filter(Boolean)
        .map((m) => ({ status: m.status, mesgid: m.mesgid, message: m.message })),
    }),
  );
}
