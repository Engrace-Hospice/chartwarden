/**
 * WardenX — Fitness Gap Checks (event catalog · seam registry · PHI guards)
 * -------------------------------------------------------------------------
 * Closes the three enforcement gaps the fitness audit flagged as runtime-only
 * (FITNESS_EVENT_SEAM_CATALOG.md §C). Each sub-check is GROUNDED in the manifest +
 * the ratified conventions and is ARMED-BUT-INERT until the relevant implementation
 * source lands — the same posture as check-table-ownership.ts / check-tenancy.ts
 * (heuristic, import-level, "activates per file as source lands"). With no
 * apps//packages/ code yet, all three report `inert` and exit 0; once code lands they
 * begin enforcing automatically.
 *
 *   1. EVENT CATALOG  — every outbox event name follows `mN.<resource>.<verb>` and the
 *      declaring module owns the `mN.` prefix (ADR/M01 D8 outbox_event_catalog; M03 D9;
 *      M04 action-catalog convention). Declared `consumers` must be real module ids.
 *      Source: outbox-events registry / events-by-mN.ts contribution files.
 *   2. SEAM REGISTRY  — every seam consumed (boot-injected) is registered in REQUIRED_SEAMS
 *      and exposed by some module (validateSeams() completeness, statically).
 *      Source: seams directories, REQUIRED_SEAMS, registerSeam(...).
 *   3. PHI GUARDS     — every PHI table (org-scoped) declares an RLS policy + an audit
 *      trigger (M01 RLS generator + M04 audit triggers).
 *      Source: packages/db schema files + migration .sql files.
 *
 * Run: bun run scripts/check-fitness-gaps.ts   (alias: bun run arch:gaps)
 * CI:  exits 1 on any violation; exits 0 (with an `inert` note) when source is absent.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODULES } from "../architecture/module-manifest";

const ROOT = process.cwd();
const moduleIds = new Set((MODULES as { id: number }[]).map((m) => m.id));
const M = (n: number) => `M${String(n).padStart(2, "0")}`;

// Unprefixed system events are explicitly permitted by M01 D8 ("or it's an unprefixed
// system event"). Keep this allowlist tight and visible.
const SYSTEM_EVENT_ALLOWLIST = new Set<string>([
  // `idg.decision_recorded` — the M14 canonical cross-module decision seam (M14 spec §4.4; M7 D4). Its name
  // PREDATES the `m14.` namespace and is the LOCKED consumer contract for M7/M11/M12/M16; M14 owns it
  // (events-by-m14.ts `moduleOwner: 'm14'`). Deliberately exempt from the `mN.<resource>.<verb>` prefix scan.
  "idg.decision_recorded",
]);

type V = { check: string; detail: string };
const violations: V[] = [];
const notes: string[] = [];
const fail = (check: string, detail: string) => violations.push({ check, detail });

function walk(dir: string, test: RegExp, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return acc;
  }
  for (const e of entries) {
    const rel = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(ROOT, rel));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (["node_modules", ".git", "dist", ".turbo"].includes(e)) continue;
      walk(rel, test, acc);
    } else if (test.test(rel)) acc.push(rel);
  }
  return acc;
}
const hasAppSource = existsSync(join(ROOT, "apps")) || existsSync(join(ROOT, "packages"));

// ---- 1. EVENT CATALOG -------------------------------------------------------
{
  const files = [
    ...walk("packages", /(outbox-events|events-by-m\d+)\.ts$|outbox-events\/.+\.ts$/),
    ...walk("apps", /(outbox-events|events-by-m\d+)\.ts$|outbox-events\/.+\.ts$/),
  ];
  if (files.length === 0) {
    notes.push("event-catalog: inert (no outbox-event registry source yet) — armed");
  } else {
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      // event name string literals: eventName: '...' | publish('...') | name: "mN..."
      const names = new Set<string>();
      for (const m of src.matchAll(/\b(?:eventName|name)\s*:\s*['"]([a-z0-9_]+\.[a-z0-9_.]+)['"]/g))
        names.add(m[1]!);
      for (const m of src.matchAll(/\bpublish\(\s*['"]([a-z0-9_]+\.[a-z0-9_.]+)['"]/g))
        names.add(m[1]!);
      const fileModule = /events-by-m(\d+)\.ts$/.exec(f)?.[1];
      for (const name of names) {
        if (SYSTEM_EVENT_ALLOWLIST.has(name)) continue;
        const mPrefix = /^m(\d+)\./.exec(name);
        if (!mPrefix) {
          fail(
            "event-naming",
            `'${name}' (${f}) does not follow the mN.<resource>.<verb> convention (M01 D8 / M03 D9)`,
          );
          continue;
        }
        const owner = Number(mPrefix[1]);
        if (!moduleIds.has(owner))
          fail("event-owner", `'${name}' uses prefix m${owner} which is not a module id`);
        if (fileModule && Number(fileModule) !== owner)
          fail(
            "event-namespace",
            `${f} (module m${fileModule}) declares '${name}' under another module's m${owner} prefix`,
          );
      }
      // declared consumers must be real modules
      for (const m of src.matchAll(/consumers\s*:\s*\[([^\]]*)\]/g)) {
        for (const c of m[1]!.matchAll(/['"]m(\d+)['"]/g)) {
          const cid = Number(c[1]);
          if (!moduleIds.has(cid))
            fail("event-consumer", `${f} declares consumer m${cid} which is not a module id`);
        }
      }
    }
    notes.push(`event-catalog: scanned ${files.length} registry file(s)`);
  }
}

// ---- 2. SEAM REGISTRY -------------------------------------------------------
{
  // Consumer-side files outside a `seams/` directory that legitimately call `getSeam` — the per-module
  // ABAC-resolver convention (every module's `abac-predicates.ts` / `abac-resolver-drizzle.ts`). Without
  // these, this whole sub-check was blind to a module's own ABAC layer, which is exactly where M31's
  // `PatientCaregiverReader`/`PatientAddressReader`/`ExternalGriefResourceReader` cast-resolved calls
  // hid (ARCH-018): the files that consumed them were never scanned, so an aliased-call fix here alone
  // could not have caught them.
  const seamFiles = [
    ...walk("packages", /seams?\/.+\.ts$|REQUIRED_SEAMS/),
    ...walk("apps", /seams?\/.+\.ts$|\/(abac-predicates|abac-resolver[\w-]*)\.ts$/),
  ];
  const registryHit = seamFiles.some((f) =>
    /REQUIRED_SEAMS|registerSeam/.test(readFileSync(join(ROOT, f), "utf8")),
  );
  if (seamFiles.length === 0 || !registryHit) {
    notes.push("seam-registry: inert (no seam registry source yet) — armed");
  } else {
    const registered = new Set<string>();
    const consumed = new Map<string, string>();
    for (const f of seamFiles) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/registerSeam\(\s*['"]([A-Za-z0-9_]+)['"]/g))
        registered.add(m[1]!);
      // Anchored to the CANONICAL `REQUIRED_SEAMS` export only — unanchored, this matched ANY
      // identifier merely ending in "REQUIRED_SEAMS" (e.g. `M31_REQUIRED_SEAMS`, a module's own
      // "seams I consume" documentation array, not the bootstrap registry) as if it were the real
      // thing, which is how three unregistered M31 seams read as "registered" for months (ARCH-018).
      for (const m of src.matchAll(/(?<![A-Za-z0-9_])REQUIRED_SEAMS\s*=\s*\[([^\]]*)\]/g))
        for (const s of m[1]!.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) registered.add(s[1]!);
      // Direct `getSeam("Name")` calls, PLUS the aliased forms modules use to call an untyped seam
      // name (`const rawSeam = getSeam as unknown as (name: string) => unknown; rawSeam("Name")`, or
      // a generic helper `const arm = <T>(name) => (getSeam as ...)(name) as T; arm<T>("Name")`) —
      // both read as "consumed" only via the literal token `getSeam(`, so an alias assignment
      // followed by a call through the ALIAS was invisible before.
      for (const m of src.matchAll(/getSeam\(\s*['"]([A-Za-z0-9_]+)['"]/g)) consumed.set(m[1]!, f);
      const aliasNames = [...src.matchAll(/const\s+(\w+)\s*=[^;]*\bgetSeam\b[^;]*;/g)].map(
        (m) => m[1]!,
      );
      for (const alias of aliasNames) {
        const callRe = new RegExp(`\\b${alias}(?:<[^>]*>)?\\(\\s*['"]([A-Za-z0-9_]+)['"]`, "g");
        for (const m of src.matchAll(callRe)) consumed.set(m[1]!, f);
      }
    }
    for (const [seam, f] of consumed)
      if (!registered.has(seam))
        fail(
          "seam-unregistered",
          `seam '${seam}' is consumed in ${f} but not in REQUIRED_SEAMS / registerSeam`,
        );
    notes.push(`seam-registry: ${registered.size} registered, ${consumed.size} consumed`);
  }
}

// ---- 3. PHI GUARDS (RLS + audit trigger presence) ---------------------------
{
  const schemaFiles = [
    ...walk("packages", /schema.*\.ts$/),
    ...walk("packages", /\.sql$/),
    ...walk("apps", /\.sql$/),
  ];
  if (schemaFiles.length === 0) {
    notes.push("phi-guards: inert (no schema/migration source yet) — armed");
  } else {
    // Heuristic: a table whose definition references organization_id is PHI/org-scoped and
    // must have both an RLS policy and an audit trigger somewhere in the schema corpus.
    const corpus = schemaFiles.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
    const orgScoped = new Set<string>();
    for (const m of corpus.matchAll(
      /create table\s+(?:if not exists\s+)?["']?(\w+)["']?[\s\S]{0,4000}?organization_id/gi,
    ))
      orgScoped.add(m[1]!);
    for (const t of orgScoped) {
      if (
        !new RegExp(
          `enable row level security[\\s\\S]*?${t}|${t}[\\s\\S]*?enable row level security|policy[\\s\\S]*?on\\s+${t}\\b`,
          "i",
        ).test(corpus)
      )
        fail("rls-missing", `org-scoped table '${t}' has no RLS policy/enable (M01 RLS generator)`);
      if (
        !new RegExp(`trigger[\\s\\S]*?on\\s+${t}\\b[\\s\\S]*?(audit|wardenx_audit)`, "i").test(
          corpus,
        )
      )
        fail("audit-trigger-missing", `org-scoped table '${t}' has no audit trigger (M04)`);
    }
    notes.push(
      `phi-guards: scanned ${schemaFiles.length} schema file(s), ${orgScoped.size} org-scoped table(s)`,
    );
  }
}

// ---- report -----------------------------------------------------------------
const armed = !hasAppSource ? " [no app source — all checks armed/inert]" : "";
if (violations.length === 0) {
  console.log(`✓ fitness-gaps: ${notes.join(" · ")}${armed}`);
  process.exit(0);
}
console.error(`✗ fitness-gaps: ${violations.length} violation(s)\n  ${notes.join(" · ")}\n`);
for (const v of violations) console.error(`  [${v.check}] ${v.detail}`);
process.exit(1);
