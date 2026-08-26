/**
 * WardenX — Outbox Binding ↔ Event-Catalog Agreement Check  (TASK-006/OPS-001; fitness check #16)
 * -----------------------------------------------------------------------------------------------
 * Every LIVE outbox consumer binding must agree with the boot event catalog it is dispatched from.
 *
 * WHY THIS GATE EXISTS. `createOutboxDispatcher` already validates exactly this
 * (`assertBindableAgainstCatalog`, bootstrap/outbox-dispatcher.ts) — and it validates it by THROWING,
 * before `server.listen()`. That would be fine if the check ran anywhere. It does not: the dispatcher
 * is constructed only when `DATABASE_PLATFORM_URL` is set, so every unit suite, every local run and
 * every CI job takes the branch where the whole validation is skipped. The result (F-020, issue #49)
 * was that TWO independent mismatches accumulated in two different modules, and the only way to find
 * out was to configure the backend the way production documents and watch it refuse to start:
 *
 *   error: outbox consumer 'm23.submission-request-enqueue' module 'm23' is not declared for
 *          'm23.claim.submission_failed'
 *   error: outbox event 'm25.edi.835_received' is catalogued record-only but has live consumer bindings
 *
 * `declaredConsumers` is hand-maintained per catalog entry and nothing cross-checked it against the
 * bindings the composition root actually registers. This is that cross-check, moved to build time.
 * Same class as GAP-086 (a live suite nothing in CI ran) and check-abac-predicates.ts (a predicate
 * name nothing resolved): a fail-closed runtime check on a code path nothing exercises is not a check.
 *
 * HOW IT CHECKS — it EVALUATES, it does not parse. Unlike the other static fitness scripts this one
 * imports each consumer module and CALLS its `build…Consumer` factory with an absorbing stub, then
 * reads `consumerName`/`consumerModule`/`eventTypes` off the object the factory really returns. That
 * is deliberate: the bindings express their event lists through six different indirections today
 * (`[...M22_DOCUMENT_REQUEST_EVENTS]`, `[M13_DOCUMENT_BACKREF_CONSUMER.eventName]`,
 * `Object.keys(REMITTANCE_TRANSITION_BY_TOPIC)`, bare consts, `as const` tuples, arrays returned from
 * a factory). A regex would need a bespoke rule per shape, and a rule that silently failed to resolve
 * one would reintroduce the exact blind spot this gate exists to close. The factories are pure with
 * respect to these three fields — they depend on the PRESENCE of their deps, not their behaviour — so
 * calling them yields the real values, not an approximation of them.
 *
 * A discovered binding file that yields NO binding is an ERROR, never a skip. "I could not evaluate
 * this one" and "this one is fine" must not look the same.
 *
 * WHAT IT ASSERTS (the three rules of `assertBindableAgainstCatalog`, verbatim):
 *   1. the bound event exists in the boot catalog;
 *   2. an event catalogued record-only (`declaredConsumers: []`) has no live binding;
 *   3. the binding's module is named in that event's `declaredConsumers`.
 *
 * The catalog is assembled the way BOOT assembles it — from the `MNN_OUTBOX_EVENTS` contributions
 * index.ts actually passes to `buildBootOutboxCatalog`, not from every contribution file on disk. A
 * module whose catalog file exists but was never registered at boot fails rule 1 here, which is what
 * boot would do too.
 *
 * SCOPE. This proves the catalog and the bindings AGREE. It does not prove the composition root
 * registers any given binding, nor that the relay runs — the `outbox-boot` CI job covers that.
 *
 * Run:   bun run scripts/check-outbox-bindings.ts
 * CI:    exits 1 on any disagreement (arch:fitness stage).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildBootOutboxCatalog } from "../apps/backend/src/bootstrap/outbox-persister";
import type { ModuleEventContribution, OutboxEventEntry } from "../packages/types/src/index";

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "__tests__"]);
const COMPOSITION_ROOT = "apps/backend/src/index.ts";

/**
 * The dispatcher DEFINES `OutboxConsumerBinding`; it does not bind one. Excluded by path rather than
 * by heuristic so that adding an interface field never silently changes what is scanned.
 */
const NOT_A_BINDING_SITE = new Set(["apps/backend/src/bootstrap/outbox-dispatcher.ts"]);

/** Absorbs any dependency shape a factory touches while building its binding object. */
function absorbingStub(): unknown {
  const stub: unknown = new Proxy(function stubFn() {} as unknown as object, {
    // `then` must stay undefined: an absorbing `then` makes the stub look like a thenable and any
    // `await` of it hangs forever.
    get: (_target, prop) => (prop === "then" ? undefined : stub),
    apply: () => stub,
    construct: () => stub as object,
  });
  return stub;
}

interface DiscoveredBinding {
  readonly file: string;
  readonly factory: string;
  readonly consumerName: string;
  readonly consumerModule: string;
  readonly eventTypes: readonly string[];
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.includes(".test."))
        out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

/** Files that declare a consumer binding: they name both halves of the dispatcher's contract. */
function bindingSites(): string[] {
  const sites: string[] = [];
  for (const file of sourceFiles()) {
    const rel = relative(REPO_ROOT, file);
    if (NOT_A_BINDING_SITE.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    if (/\bconsumerModule\s*:/.test(src) && /\beventTypes\s*:/.test(src)) sites.push(rel);
  }
  return sites.sort();
}

const looksLikeBinding = (value: unknown): value is DiscoveredBinding =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { consumerName?: unknown }).consumerName === "string" &&
  typeof (value as { consumerModule?: unknown }).consumerModule === "string" &&
  Array.isArray((value as { eventTypes?: unknown }).eventTypes);

/** Import one binding site and evaluate every `build…Consumer(s)` factory it exports. */
async function bindingsIn(
  rel: string,
): Promise<{ bindings: DiscoveredBinding[]; errors: string[] }> {
  const bindings: DiscoveredBinding[] = [];
  const errors: string[] = [];
  let ns: Record<string, unknown>;
  try {
    ns = (await import(join(REPO_ROOT, rel))) as Record<string, unknown>;
  } catch (error) {
    return { bindings, errors: [`${rel}: could not be imported — ${(error as Error).message}`] };
  }
  for (const [name, exported] of Object.entries(ns)) {
    if (typeof exported !== "function" || !/^build[A-Za-z0-9]*Consumers?$/.test(name)) continue;
    let produced: unknown;
    try {
      const stub = absorbingStub();
      produced = (exported as (...args: unknown[]) => unknown)(stub, stub, stub, stub);
    } catch (error) {
      errors.push(
        `${rel}: ${name}() threw while building its binding — ${(error as Error).message}`,
      );
      continue;
    }
    for (const candidate of Array.isArray(produced) ? produced : [produced]) {
      if (!looksLikeBinding(candidate)) continue;
      bindings.push({
        file: rel,
        factory: name,
        consumerName: candidate.consumerName,
        consumerModule: candidate.consumerModule,
        eventTypes: [...candidate.eventTypes],
      });
    }
  }
  return { bindings, errors };
}

/** The `MNN_OUTBOX_EVENTS` contributions the composition root really passes to the boot catalog. */
function bootCatalogContributionNames(): string[] {
  const src = readFileSync(join(REPO_ROOT, COMPOSITION_ROOT), "utf8");
  const start = src.indexOf("buildBootOutboxCatalog([");
  if (start === -1) {
    throw new Error(`${COMPOSITION_ROOT}: no buildBootOutboxCatalog([…]) call found`);
  }
  // Balance brackets from the opening `[` so a nested array can never truncate the argument list.
  const open = src.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "[") depth += 1;
    else if (src[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`${COMPOSITION_ROOT}: unbalanced buildBootOutboxCatalog([…])`);
  const body = src
    .slice(open, end)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return [...new Set(body.match(/\bM\d+_OUTBOX_EVENTS\b/g) ?? [])].sort();
}

/** Resolve each contribution name to the module that exports it, and import the value. */
async function bootCatalog(): Promise<{
  catalog: ReadonlyMap<string, OutboxEventEntry>;
  errors: string[];
}> {
  const errors: string[] = [];
  const contributions: ModuleEventContribution[] = [];
  const files = sourceFiles();
  for (const name of bootCatalogContributionNames()) {
    const owner = files.find((file) =>
      new RegExp(`export\\s+const\\s+${name}\\b`).test(readFileSync(file, "utf8")),
    );
    if (!owner) {
      errors.push(`${COMPOSITION_ROOT} registers ${name}, which no source file exports`);
      continue;
    }
    const ns = (await import(owner)) as Record<string, unknown>;
    contributions.push(ns[name] as ModuleEventContribution);
  }
  return { catalog: buildBootOutboxCatalog(contributions), errors };
}

async function main(): Promise<void> {
  const failures: string[] = [];

  const { catalog, errors: catalogErrors } = await bootCatalog();
  failures.push(...catalogErrors);

  const sites = bindingSites();
  const bindings: DiscoveredBinding[] = [];
  for (const site of sites) {
    const { bindings: found, errors } = await bindingsIn(site);
    failures.push(...errors);
    if (errors.length === 0 && found.length === 0) {
      failures.push(
        `${site}: declares a consumer binding but no build…Consumer() factory produced one — this gate cannot vouch for it, and an unverifiable binding must not look like a passing one`,
      );
    }
    bindings.push(...found);
  }

  // The three rules of assertBindableAgainstCatalog, applied at build time.
  for (const binding of [...bindings].sort((a, b) =>
    a.consumerName.localeCompare(b.consumerName),
  )) {
    for (const eventType of binding.eventTypes) {
      const entry = catalog.get(eventType);
      if (!entry) {
        failures.push(
          `${binding.file}: consumer '${binding.consumerName}' binds '${eventType}', which the boot catalog does not carry (unknown event, or its MNN_OUTBOX_EVENTS is not registered in ${COMPOSITION_ROOT})`,
        );
        continue;
      }
      if (entry.declaredConsumers.length === 0) {
        failures.push(
          `${binding.file}: event '${eventType}' is catalogued record-only (declaredConsumers: []) but '${binding.consumerName}' binds it live — the dispatcher would mark it dispatched without delivering, so declare the consumer or drop the binding`,
        );
        continue;
      }
      if (!entry.declaredConsumers.includes(binding.consumerModule as never)) {
        failures.push(
          `${binding.file}: consumer '${binding.consumerName}' module '${binding.consumerModule}' ` +
            `is not in declaredConsumers for '${eventType}' [${entry.declaredConsumers.join(", ")}]`,
        );
      }
    }
  }

  const boundEvents = new Set(bindings.flatMap((b) => b.eventTypes));
  console.log(
    `Outbox bindings: ${bindings.length} live binding(s) across ${sites.length} file(s), ` +
      `covering ${boundEvents.size} of ${catalog.size} catalogued event(s).`,
  );

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} outbox binding/catalog disagreement(s):\n`);
    for (const failure of failures) console.error(`  · ${failure}`);
    console.error(
      "\nThe outbox dispatcher throws on each of these at boot, before server.listen(). Fix the\n" +
        "catalog entry (events-by-mNN.ts) or the binding — do not relax this gate.",
    );
    process.exit(1);
  }
  console.log("✓ every live outbox binding agrees with the boot event catalog.");
}

await main();
