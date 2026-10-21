/**
 * ChartWarden — demo patient seed (local dev). NOT for production / real PHI.
 *
 * Admits a handful of demo patients through the real M5 admit route (POST /api/v1/patients) so the
 * clinical screens (census, chart) show data. Goes through HTTP (not raw SQL) because the patient
 * spine is envelope-encrypted (MBI/SSN) and the matcher/§7.1 logic lives in the service.
 *
 * Prereqs: backend + web running, users seeded (bun run db:seed). Auths as admin@chartwarden.local.
 * Run:     bun run db:seed:patients
 */
import { readFileSync } from "node:fs";
import { group } from "../lib/strict";
import { SEED_CREDENTIALS_PATH } from "./lib/credentials";
import { stepUpSession } from "./lib/step-up";

const API = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const ORG_SLUG = "chartwarden-demo";
const ADMIN_EMAIL = "admin@chartwarden.local";

/** GAP-009: skipping the duplicate-match review must say why (20-1000 chars); recorded on the audit. */
const BYPASS_JUSTIFICATION =
  "Local demo seed: synthetic patients on an empty database, no real duplicates to review.";

export const PATIENTS = [
  {
    lastName: "Whitfield",
    firstName: "Eleanor",
    dob: "1939-03-12",
    administrativeSex: "female",
    primaryAddress: {
      line1: "42 Camellia Ln",
      city: "Asheville",
      state: "NC",
      postalCode: "28801",
    },
    phone: "+18285551042",
  },
  {
    lastName: "Okonkwo",
    firstName: "Samuel",
    dob: "1945-11-02",
    administrativeSex: "male",
    primaryAddress: { line1: "1187 Birch St", city: "Asheville", state: "NC", postalCode: "28805" },
    phone: "+18285552187",
  },
  {
    lastName: "Delgado",
    firstName: "Rosa",
    dob: "1951-06-28",
    administrativeSex: "female",
    primaryAddress: {
      line1: "9 Mountain View Ct",
      city: "Hendersonville",
      state: "NC",
      postalCode: "28792",
    },
  },
  {
    lastName: "Nakamura",
    firstName: "Henry",
    dob: "1936-01-19",
    administrativeSex: "male",
    primaryAddress: {
      line1: "330 Sweeten Creek Rd",
      city: "Asheville",
      state: "NC",
      postalCode: "28803",
    },
    phone: "+18285553301",
  },
  {
    lastName: "Brandt",
    firstName: "Margaret",
    dob: "1948-09-05",
    administrativeSex: "female",
    primaryAddress: {
      line1: "76 Riverside Dr",
      city: "Asheville",
      state: "NC",
      postalCode: "28804",
    },
  },
  {
    lastName: "Fairbanks",
    firstName: "Walter",
    dob: "1942-12-30",
    administrativeSex: "male",
    primaryAddress: {
      line1: "215 Oak Knoll Dr",
      city: "Black Mountain",
      state: "NC",
      postalCode: "28711",
    },
    phone: "+18285554215",
  },
];

function adminPassword(): string {
  const md = readFileSync(SEED_CREDENTIALS_PATH, "utf8");
  const line = md.split("\n").find((l) => l.includes(ADMIN_EMAIL));
  const m = line?.match(/`([^`]+)`\s*\|\s*`([^`]+)`/);
  if (!m)
    throw new Error("could not read admin password from CREDENTIALS.local.md (run db:seed first)");
  return group(m, 2, "CREDENTIALS.local.md password cell");
}

/** Minimal cookie jar over fetch (Better Auth uses a session cookie). */
function cookieHeader(store: Map<string, string>): string {
  return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(store: Map<string, string>, res: Response): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    // `split(";")` always yields at least one element, so `pair` is always a string — but the
    // type cannot say so. `?? ""` costs nothing and makes the empty-header case a no-op rather
    // than a throw.
    const pair = c.split(";")[0] ?? "";
    const idx = pair.indexOf("=");
    if (idx > 0) store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
/**
 * The M1 CSRF plugin (WX-PR-017, apps/backend/src/bootstrap/plugins/csrf.ts) mints a `chartwarden_csrf`
 * cookie on every response and requires it echoed back in `X-CSRF-Token` on a mutating request that
 * also carries the Better Auth session cookie — which every POST below does, having just signed in.
 * A raw script client gets no free pass; it has to double-submit the same way a real browser does.
 */
function csrfHeader(store: Map<string, string>): Record<string, string> {
  const token = store.get("chartwarden_csrf");
  return token ? { "x-csrf-token": token } : {};
}

async function main(): Promise<void> {
  const jar = new Map<string, string>();
  const password = adminPassword();

  // 1) sign in
  const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password }),
  });
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  absorb(jar, signIn);
  const adminUserId = ((await signIn.json()) as { user?: { id?: string } }).user?.id;
  if (!adminUserId) throw new Error("sign-in response carried no user id");

  // 2) resolve org id from memberships, then select it
  const mem = await fetch(`${API}/api/v1/auth/memberships`, {
    headers: { cookie: cookieHeader(jar) },
  });
  absorb(jar, mem);
  if (!mem.ok) throw new Error(`list memberships failed: ${mem.status} ${await mem.text()}`);
  const memBody = (await mem.json()) as {
    memberships: Array<{ organizationId: string; organizationName: string }>;
  };
  const org = memBody.memberships[0];
  if (!org) throw new Error("admin has no memberships — run db:seed first");

  const sel = await fetch(`${API}/api/v1/auth/select-organization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: cookieHeader(jar),
      ...csrfHeader(jar),
    },
    body: JSON.stringify({ organizationId: org.organizationId }),
  });
  absorb(jar, sel);
  if (!sel.ok) throw new Error(`select-organization failed: ${sel.status} ${await sel.text()}`);
  console.log(`authenticated as ${ADMIN_EMAIL} @ ${org.organizationName}`);

  // 3) admit patients
  let created = 0;
  let dup = 0;
  let failed = 0;
  for (const p of PATIENTS) {
    // Admitting a patient is step-up gated (STEP_UP_REQUIRED without a fresh step-up). A seed cannot
    // answer a TOTP/WebAuthn challenge, so use the shared stand-in (lib/step-up.ts) immediately
    // before each gated request — a step-up lasts 300 s, but one call per admit keeps it airtight.
    await stepUpSession(adminUserId);
    const res = await fetch(`${API}/api/v1/patients`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: cookieHeader(jar),
        ...csrfHeader(jar),
      },
      body: JSON.stringify({
        ...p,
        bypassMatchReview: true,
        bypassJustification: BYPASS_JUSTIFICATION,
      }),
    });
    if (res.status === 201) {
      created++;
      console.log(`  ✓ admitted ${p.firstName} ${p.lastName}`);
    } else if (res.status === 409) {
      dup++;
      console.log(`  • ${p.firstName} ${p.lastName} already present (dup)`);
    } else {
      failed++;
      console.log(`  ✗ ${p.firstName} ${p.lastName}: HTTP ${res.status} ${await res.text()}`);
    }
  }
  console.log(
    `\n${failed === 0 ? "✓" : "✗"} patient seed: ${created} admitted, ${dup} already present, ${failed} failed (of ${PATIENTS.length}).`,
  );
  // A seed that logs a failure and still exits 0 lets `db:seed:all` carry on into steps that need these patients.
  if (failed > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
