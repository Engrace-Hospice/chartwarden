/**
 * WardenX — demo patient seed (local dev). NOT for production / real PHI.
 *
 * Admits a handful of demo patients through the real M5 admit route (POST /api/v1/patients) so the
 * clinical screens (census, chart) show data. Goes through HTTP (not raw SQL) because the patient
 * spine is envelope-encrypted (MBI/SSN) and the matcher/§7.1 logic lives in the service.
 *
 * Prereqs: backend + web running, users seeded (bun run db:seed). Auths as admin@wardenx.local.
 * Run:     bun run db:seed:patients
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const ORG_SLUG = "wardenx-demo";
const ADMIN_EMAIL = "admin@wardenx.local";

const PATIENTS = [
  { lastName: "Whitfield", firstName: "Eleanor", dob: "1939-03-12", administrativeSex: "female",
    primaryAddress: { line1: "42 Camellia Ln", city: "Asheville", postalCode: "28801" }, phone: "+18285551042" },
  { lastName: "Okonkwo", firstName: "Samuel", dob: "1945-11-02", administrativeSex: "male",
    primaryAddress: { line1: "1187 Birch St", city: "Asheville", postalCode: "28805" }, phone: "+18285552187" },
  { lastName: "Delgado", firstName: "Rosa", dob: "1951-06-28", administrativeSex: "female",
    primaryAddress: { line1: "9 Mountain View Ct", city: "Hendersonville", postalCode: "28792" } },
  { lastName: "Nakamura", firstName: "Henry", dob: "1936-01-19", administrativeSex: "male",
    primaryAddress: { line1: "330 Sweeten Creek Rd", city: "Asheville", postalCode: "28803" }, phone: "+18285553301" },
  { lastName: "Brandt", firstName: "Margaret", dob: "1948-09-05", administrativeSex: "female",
    primaryAddress: { line1: "76 Riverside Dr", city: "Asheville", postalCode: "28804" } },
  { lastName: "Fairbanks", firstName: "Walter", dob: "1942-12-30", administrativeSex: "male",
    primaryAddress: { line1: "215 Oak Knoll Dr", city: "Black Mountain", postalCode: "28711" }, phone: "+18285554215" },
];

function adminPassword(): string {
  const md = readFileSync(join(process.cwd(), "CREDENTIALS.local.md"), "utf8");
  const line = md.split("\n").find((l) => l.includes(ADMIN_EMAIL));
  const m = line?.match(/`([^`]+)`\s*\|\s*`([^`]+)`/);
  if (!m) throw new Error("could not read admin password from CREDENTIALS.local.md (run db:seed first)");
  return m[2];
}

/** Minimal cookie jar over fetch (Better Auth uses a session cookie). */
function cookieHeader(store: Map<string, string>): string {
  return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(store: Map<string, string>, res: Response): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
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

  // 2) resolve org id from memberships, then select it
  const mem = await fetch(`${API}/api/v1/auth/memberships`, { headers: { cookie: cookieHeader(jar) } });
  const memBody = (await mem.json()) as { memberships: Array<{ organizationId: string; organizationName: string }> };
  const org = memBody.memberships[0];
  if (!org) throw new Error("admin has no memberships — run db:seed first");

  const sel = await fetch(`${API}/api/v1/auth/select-organization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader(jar) },
    body: JSON.stringify({ organizationId: org.organizationId }),
  });
  absorb(jar, sel);
  if (!sel.ok) throw new Error(`select-organization failed: ${sel.status} ${await sel.text()}`);
  console.log(`authenticated as ${ADMIN_EMAIL} @ ${org.organizationName}`);

  // 3) admit patients
  let created = 0;
  let dup = 0;
  for (const p of PATIENTS) {
    const res = await fetch(`${API}/api/v1/patients`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: cookieHeader(jar) },
      body: JSON.stringify({ ...p, bypassMatchReview: true }),
    });
    if (res.status === 201) {
      created++;
      console.log(`  ✓ admitted ${p.firstName} ${p.lastName}`);
    } else if (res.status === 409) {
      dup++;
      console.log(`  • ${p.firstName} ${p.lastName} already present (dup)`);
    } else {
      console.log(`  ✗ ${p.firstName} ${p.lastName}: HTTP ${res.status} ${await res.text()}`);
    }
  }
  console.log(`\n✓ patient seed: ${created} admitted, ${dup} already present (of ${PATIENTS.length}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
