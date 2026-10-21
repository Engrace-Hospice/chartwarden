#!/usr/bin/env bun
/**
 * ChartWarden — request-context attribute producer gate (F-030)
 * ---------------------------------------------------------------------------
 * `request.context.attributes` is the untyped bag the authenticate hook fills with
 * SERVER-ASSEMBLED facts about the caller — membership, principal kind, session id, step-up
 * freshness — and that ABAC predicates and route actors read back out. It is `Record<string,
 * unknown>`, so a read of a key nothing ever writes compiles, evaluates, and returns `undefined`.
 *
 * Every reader treats `undefined` as deny, so this always failed CLOSED: never exposure, always
 * authorization logic that has never once run. Four instances had already been found and fixed one
 * at a time before anyone looked for the pattern:
 *
 *   `membershipId`                    — 7 modules' §4.x ownership predicates saw null and denied
 *   `providerEntityIds`/`locationIds` — every PE/location predicate denied unconditionally (ARCH-008/009)
 *   `stepUpRecent`                    — 15 modules; M23/M27/M37 mount `requireStepUp`, which PASSES,
 *                                       then refuse in the domain on the always-false flag (F-029)
 *   `systemPrincipal`                 — one fact under two names: `actorKind` was stamped and checked
 *                                       by M15/M23's `requireSystemPrincipal()`, while M23's predicate
 *                                       and M25's internal-seam guard checked a name nothing wrote,
 *                                       so those service-to-service routes refused every caller (F-030)
 *   the session's pinned patient      — the same shape once more, at THREE names: M31/M19 read it as
 *                                       `portalPatientId`, M19's portal-triage guard read
 *                                       `portalPatientId ?? patientId`, and M7's `caseload_or_scope`
 *                                       read a `scopePatientIds` ARRAY. One fact (`session.scope
 *                                       .patientId`), no writer, and a `??` chain of two undefineds
 *                                       that read as a safety net. Now one key, `sessionPatientId`,
 *                                       named for the fact rather than for one of its three readers.
 *
 * The common shape: the read is correct, the doc comment asserts the hook assembles it, and nothing
 * assembles it. `arch:abac-predicates` cannot see this — it proves a predicate NAME resolves, not
 * that the FACTS the predicate reads are ever produced.
 *
 * WHAT THIS ENFORCES. Every key read off a context-attributes bag is declared in
 * {@link CONTEXT_ATTRIBUTES} as one of:
 *
 *   `{ producer }` — something in source writes it. The gate verifies a write EXISTS: a declared
 *                    producer that stops writing is the exact regression this gate is for.
 *   `{ blocked }`  — nothing writes it yet, and the entry says why and what it needs. Legal, because
 *                    a fact whose source does not exist yet is a real state — but it must be
 *                    DECLARED, the way `deviceAttestationValid` is a registered predicate that denies
 *                    and says why rather than an unregistered name. Both refuse identically; only the
 *                    declared one is distinguishable from a mistake.
 *
 * A `blocked` key that GAINS a writer is an error, so an entry cannot outlive its reason. An
 * undeclared key is an error. A declared key nothing reads is an error (a stale registry is how a
 * registry stops being read).
 *
 * Run:  bun run arch:context-attributes   (in `arch:fitness`)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is a Bun extension and is `undefined` under Vitest, which imports this module
// directly for the gate's own test; `import.meta.url` is standard and resolves the same path in both.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_PREFIXES = ["apps/backend/src", "packages"];

export interface AttributeEntry {
  /** Where the fact is assembled — prose, but it must correspond to a real write the gate can find. */
  readonly producer?: string;
  /** Why nothing produces it yet, and what it needs. Mutually exclusive with `producer`. */
  readonly blocked?: string;
}

/**
 * Every key read off `context.attributes`, and where its value comes from.
 *
 * The `blocked` entries are not a to-do list the gate tolerates — they are the finding. Each one is
 * a control that is present, tested against a stubbed value, and has never run in production.
 */
export const CONTEXT_ATTRIBUTES: Readonly<Record<string, AttributeEntry>> = {
  // ── produced ────────────────────────────────────────────────────────────────────────────────────
  sessionExpired: {
    producer:
      "authenticate hook — set to the SessionTimeoutEnforcer verdict (expired_idle / expired_absolute / revoked) when it ends the session; read by the error handler to answer 401 SESSION_EXPIRED (GAP-002, bootstrap/plugins/authenticate.ts).",
  },
  sessionId: {
    producer:
      "authenticate hook — the real Better Auth session id, from the session snapshot (bootstrap/plugins/authenticate.ts).",
  },
  actorKind: {
    producer:
      'authenticate hook — `"system"` only inside the verified shared-secret branch, `"user"` for a resolved interactive session. The one principal-kind fact; see the F-030 note on `systemPrincipal`.',
  },
  membershipId: {
    producer:
      "authenticate hook — `ResolvedActor.membershipId` for the caller's ACTIVE membership in the scope org (null when none).",
  },
  stepUpRecent: {
    producer:
      "authenticate hook — resolved through `stepUpFreshFor` against the real session state and the platform-floor policy (F-029). Floor answer only; `requireStepUp(opKey)` is the per-operation form.",
  },
  orgTimezone: {
    producer:
      "M17 scheduling routes — stamped per request from the org's configured IANA zone before the visit-window predicates read it.",
  },
  sessionClass: {
    producer:
      "authenticate hook — `ResolvedActor.sessionClass`, off the M1 `session.session_class` column. The three M31 portal classes and the two M19 vendor classes were added to that enum by migration 0219; before it they could not be the value of any real session, so every predicate gating on them denied unconditionally (F-030).",
  },
  portalAccountId: {
    producer:
      "authenticate hook — the portal account off the session's `scope` jsonb, written at mint by M2's `PortalSessionBinder`. Null on every non-portal class. Never falls back to a request parameter (§8.3.1).",
  },
  sessionPatientId: {
    producer:
      "authenticate hook — the ONE patient the session is pinned to, resolved through `sessionPinnedPatientId` off the `scope` jsonb (so the CLASS decides, not the presence of a key). Legitimately null between mint and select-patient on a portal session (M31 §2.3 / D2), which is why the CHECK requires the ACCOUNT and not the patient; non-null from mint on collaborator/funeral. Retired three names for this one fact: M31/M19's `portalPatientId`, M19's `patientId` fallback beside it, and M7's `scopePatientIds` array.",
  },

  breakGlassEventId: {
    producer:
      "`requireAbac`'s break-glass branch (packages/auth/src/abac/require-abac.ts) — stamped onto the SAME attributes object the handler reads, by reference, when an emergency grant carries the call.",
  },
  "idg.reviewFloorOverrideAuthorized": {
    producer:
      "M14's `per_patient_review_floor_clear` predicate (GAP-091) — set when the audited escape valve allows, so the handler knows to pass `overrideAuthorized` into the service. Read through the exported `REVIEW_FLOOR_OVERRIDE_ATTRIBUTE` constant, not the literal.",
  },

  deviceAttestation: {
    producer:
      "authenticate hook — `ResolvedActor.deviceAttestation`, resolved from M2's `device_attestation` row through the session's `device_attestation_id` pointer and RE-CHECKED there (`liveDeviceAttestation`: verdict, revocation, expiry), so a stale or dangling pointer yields null and the gate denies. Written only when a LIVE attestation stands behind the session. This entry was blocked until ADR-0023 D2 was adjudicated in M2's favour — the ADR offered exactly two exits, a real `ownedTables` edit or deletion from the consuming specs, and the surface had two consumers (M3's predicate; M18's `evv_device.m2_device_attestation_id`, a logical FK to a table that did not exist).",
  },

  engagementId: {
    producer:
      "authenticate hook — `ResolvedActor.engagementId`, the `auditor_engagement` an `auditor`-class session was minted for, read from `session.scope.engagementId` through `sessionEngagementId` (class- AND window-gated: a staff session carrying a stray key, or an auditor row missing its `engagement_start/end`, stamps nothing). Stamped only when `sessionClass === 'auditor'`, from server-side session state — never a header or the route, because M31's `portal_engagement_scope` compares it against the engagement the ROUTE names (GAP-093). The write side (M2 stamping `scope.engagementId` on the session at auditor magic-link consumption) is not built yet, so until it is no live session carries one and the auditor route denies everyone — fail closed.",
  },

  auditorEnrolmentEngagementId: {
    producer:
      "authenticate hook — the `auditor`-class session's OWN engagement (`ResolvedActor.engagementId`, class- and window-gated by `sessionEngagementId`), stamped for BOTH auditor stages so the enrolment routes can be bound to it. Unlike `engagementId` it names no READ scope: an enrolment-stage session (M2 §7.7, `auditorStage !== 'active'`) gets only this key, so M31's `portal_engagement_scope` still denies it. Read only by M2's `auditor_enrolment_session` predicate, which compares it with the engagement the enrolment guard hands it (the same session-derived value).",
  },

  externalActorId: {
    producer:
      "authenticate hook — `ResolvedActor.externalActorId`, the `external_triage_vendor` row an M19 answering-service session acts for, resolved through `sessionExternalActorId` so the CLASS decides and a staff session carrying a stray `scope.externalActorId` stamps nothing (it is the authorization SUBJECT of `external_triage_actor`, so any other route to it would reach a vendor-scoped triage call). Written at mint by M2's `VendorSessionBinder`, which M19's vendor-binding route calls; migration 0223 makes `scope.externalActorId` a `session_scope_chk` requirement of both vendor classes, so a vendor session with no vendor cannot be written at all.",
  },
};

export interface AttributeUse {
  readonly file: string;
  readonly line: number;
  readonly key: string;
}

const READ_RE =
  /attributes\??\.([A-Za-z_$][\w$]*)|attributes\??\[\s*["'`]([^"'`]+)["'`]\s*\]|attributes\??\[\s*([A-Z_][A-Z0-9_]*)\s*\]/g;
/** `attributes.foo =`, `attributes["foo"] =`, `attributes.foo ??=` — an assignment, not a comparison. */
const WRITE_RE =
  /attributes\??(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\]|\[\s*([A-Z_][A-Z0-9_]*)\s*\])\s*(?:\?\?)?=(?!=)/g;
/** `const FOO = "literal"` — resolves `attributes[PHI_FULL_READ_GRANT]` to the key it reads. */
const CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["'`]([^"'`]+)["'`]/g;

/**
 * `const attrs = ctx.attributes ?? {}` — an ALIAS for the whole bag, after which every read is
 * `attrs.foo` and the token `attributes` never appears again on the line.
 *
 * This is not a hypothetical: it is how M31's `actorOf` reads `portalAccountId`/`sessionPatientId`,
 * two of the unproduced keys, so a scanner that only matched `attributes.<key>` would have declared
 * the registry entry for `sessionPatientId` unused and been wrong. The alias is resolved per FILE
 * (unlike the string constants, which are resolved across files) because it is always a local.
 */
const ALIAS_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*[A-Za-z_$][\w$.?]*\.attributes\s*(?:\?\?\s*\{\s*\})?\s*[;\n]/g;

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function isTestFile(file: string): boolean {
  return file.includes("__tests__") || file.endsWith(".test.ts") || file.includes("/dist/");
}

export interface ScanResult {
  readonly reads: AttributeUse[];
  readonly writes: AttributeUse[];
}

/**
 * Every context-attribute read and write in production source.
 *
 * Tests are excluded on purpose: every one of the four historical instances was invisible precisely
 * BECAUSE each suite wrote the attribute itself in its own fake authenticate hook. Counting those as
 * producers would make this gate agree with the bug.
 */
export function scanContextAttributes(root: string = REPO_ROOT): ScanResult {
  const files = execFileSync("git", ["ls-files", "-z", ...SCAN_PREFIXES], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f.endsWith(".ts") && !isTestFile(f));

  // Constants are resolved ACROSS files, not per file: `attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]`
  // is read in a route and declared in the module's predicate file, and `BREAK_GLASS_ATTRIBUTE` is
  // declared in @chartwarden/auth and read there. Keying the registry on identifiers instead of the
  // header-style literals they resolve to would make it a registry of variable names.
  const consts = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    sources.set(file, src);
    if (!src.includes("attributes")) continue;
    for (const m of src.matchAll(CONST_RE)) {
      const [, name, value] = m;
      if (name && value) consts.set(name, value);
    }
  }

  const reads: AttributeUse[] = [];
  const writes: AttributeUse[] = [];
  for (const file of files) {
    const src = sources.get(file);
    if (!src || !src.includes("attributes")) continue;

    const resolve = (raw: string): string => consts.get(raw) ?? raw;

    // Bag aliases declared in this file, so `attrs.foo` counts as a read of `foo`.
    const aliases = [...src.matchAll(ALIAS_RE)].map((m) => m[1]).filter((a): a is string => !!a);
    const aliasRead = aliases.length
      ? new RegExp(`\\b(?:${aliases.join("|")})\\??\\.([A-Za-z_$][\\w$]*)`, "g")
      : null;
    const aliasWrite = aliases.length
      ? new RegExp(
          `\\b(?:${aliases.join("|")})\\??\\.([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?)?=(?!=)`,
          "g",
        )
      : null;

    src.split("\n").forEach((text, i) => {
      if (isComment(text)) return;
      const seen = new Set<string>();
      for (const m of text.matchAll(WRITE_RE)) {
        // The third arm is the SCREAMING_CASE identifier form (`attributes[BREAK_GLASS_ATTRIBUTE] =`),
        // which is how both of the in-request producers actually write — matching only `.key` and
        // `["literal"]` reported them as producer-missing, i.e. as the very bug this gate detects.
        const key = resolve((m[1] ?? m[2] ?? m[3]) as string);
        writes.push({ file, line: i + 1, key });
        seen.add(key);
      }
      if (aliasWrite) {
        for (const m of text.matchAll(aliasWrite)) {
          const key = resolve(m[1] as string);
          writes.push({ file, line: i + 1, key });
          seen.add(key);
        }
      }
      for (const m of text.matchAll(READ_RE)) {
        const key = resolve((m[1] ?? m[2] ?? m[3]) as string);
        // A line that assigns the key also matches the read pattern; count it once, as a write.
        if (!seen.has(key)) reads.push({ file, line: i + 1, key });
      }
      if (aliasRead) {
        for (const m of text.matchAll(aliasRead)) {
          const key = resolve(m[1] as string);
          if (!seen.has(key)) reads.push({ file, line: i + 1, key });
        }
      }
    });
  }
  return { reads, writes };
}

export interface Violation {
  readonly kind: "undeclared" | "producer-missing" | "blocker-stale" | "registry-unused";
  readonly key: string;
  readonly detail: string;
}

/**
 * `registry` is injectable so the gate's OWN rules stay testable independently of what the registry
 * currently holds. Every blocked-key test used to name a real blocked entry, which broke twice as this
 * work retired them and then went vacuous when the last one was fixed — a rule that can only be proven
 * while it is being violated is not a rule anyone can rely on.
 */
export function findViolations(
  scan: ScanResult,
  registry: Record<string, AttributeEntry> = CONTEXT_ATTRIBUTES,
): Violation[] {
  const readKeys = new Set(scan.reads.map((r) => r.key));
  const writeKeys = new Set(scan.writes.map((w) => w.key));
  const out: Violation[] = [];

  for (const key of [...readKeys].sort()) {
    const entry = registry[key];
    if (!entry) {
      const where = scan.reads.filter((r) => r.key === key).slice(0, 3);
      out.push({
        kind: "undeclared",
        key,
        detail: `read at ${where.map((r) => `${r.file}:${r.line}`).join(", ")} but not declared`,
      });
      continue;
    }
    if (entry.producer && !writeKeys.has(key)) {
      out.push({
        kind: "producer-missing",
        key,
        detail: `declares a producer (“${entry.producer.slice(0, 70)}…”) but nothing in source writes it`,
      });
    }
  }

  // Over the REGISTRY, not over the read keys. A blocked entry that gains a writer is stale whether or
  // not anything currently reads it — and the read-keyed loop above could not see the case where the
  // producer landed before the reader did, which is exactly the order these fixes tend to arrive in.
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.blocked && writeKeys.has(key)) {
      const where = scan.writes.filter((w) => w.key === key).slice(0, 2);
      out.push({
        kind: "blocker-stale",
        key,
        detail: `is declared blocked, but is now written at ${where.map((w) => `${w.file}:${w.line}`).join(", ")} — move it to a producer`,
      });
    }
  }

  for (const key of Object.keys(registry)) {
    if (!readKeys.has(key) && !writeKeys.has(key)) {
      out.push({ kind: "registry-unused", key, detail: "declared but nothing reads or writes it" });
    }
  }
  return out;
}

if (import.meta.main) {
  const scan = scanContextAttributes();
  const violations = findViolations(scan);
  const blocked = Object.entries(CONTEXT_ATTRIBUTES).filter(([, e]) => e.blocked);

  if (violations.length === 0) {
    const produced = Object.keys(CONTEXT_ATTRIBUTES).length - blocked.length;
    console.log(
      `✓ context-attributes: ${scan.reads.length} read(s) over ${Object.keys(CONTEXT_ATTRIBUTES).length} declared key(s) — ${produced} produced, ${blocked.length} declared-blocked`,
    );
    // Blocked keys are a standing finding, not a passing state — print them every run so the count is
    // visible in CI output rather than only to whoever opens this file. The list is EMPTY as of #89:
    // every key read off the attributes bag now has a producer. A future key whose source genuinely
    // does not exist yet still belongs here rather than undeclared (the `deviceAttestationValid` rule),
    // so this stays.
    for (const [key] of blocked) console.log(`    · blocked: ${key}`);
    process.exit(0);
  }

  console.error(`✗ context-attributes: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  [${v.kind}] ${v.key} — ${v.detail}`);
  console.error(
    "\n  Every key read off `request.context.attributes` must be declared in CONTEXT_ATTRIBUTES\n" +
      "  (scripts/check-context-attributes.ts) with either:\n" +
      "\n" +
      "    producer — where the fact is assembled. A write must actually exist in source.\n" +
      "    blocked  — nothing produces it yet, WITH the reason and what it needs.\n" +
      "\n" +
      "  A read of an unproduced key compiles and returns `undefined`, and every reader treats that\n" +
      "  as deny — so the failure is silent, permanent, and looks exactly like working code.",
  );
  process.exit(1);
}
