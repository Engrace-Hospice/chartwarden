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
 * WHAT IT ASSERTS. Rules 1-3 are `assertBindableAgainstCatalog`, verbatim:
 *   1. the bound event exists in the boot catalog;
 *   2. an event catalogued record-only (`declaredConsumers: []`) has no live binding;
 *   3. the binding's module is named in that event's `declaredConsumers`.
 *
 * Rule 4 is the direction none of them ran (F-043, issue #103):
 *   4. every module a catalogued event names in `declaredConsumers` has a LIVE BINDING for it —
 *      or the (module, event) pair is named in `outbox-deferred-consumers.ts` with a reason.
 *
 * Rule 6 is the direction rule 4 still did not run (F-094, issue #205):
 *   6. a module that publishes an `M<N>_SUBSCRIBED_EVENT_NAMES` constant must agree with the catalog
 *      about what it subscribes to, BOTH WAYS — every name it lists is catalogued and declares that
 *      module, and every catalogued event declaring that module is in its list.
 *
 * Six modules publish such a constant, and each carries a doc comment of the same form: "Listed here —
 * not only in the worker files — so the consumer wiring and the §9 tests share one source of truth, and
 * so an upstream rename breaks the build rather than silently orphaning a handler." Nothing compared any
 * of them to anything. They are string-literal tuples, and the tests that reference them assert the
 * list's SHAPE (three dot-separated segments, no self-consumption, contains one particular corrected
 * name) and never that a name EXISTS. So the six lists and the catalog disagreed on 65 facts, in both
 * directions, and the direction that costs most is neither of rule 4's: a name the catalog does not
 * declare is a handler the relay routes NOTHING to, which is what #204 had to fix before M20's binding
 * did anything at all. Writing the binding is not enough if the declaration is missing, and before this
 * rule nothing told you which case you were in.
 *
 * All three original rules run binding -> catalog. An event declaring `["m33", "m36"]` with zero
 * consumers anywhere satisfied every one of them and passed green, so the catalog read as if all 599
 * of its consumer-declaring entries were wired when 570 of them were not. Same unasked-direction
 * defect as F-025/#59, where the live-suite gate checked package.json -> CI and never CI ->
 * package.json and 29 suite files ran nowhere. The fix is the same: ask both directions, and name the
 * exceptions rather than leaving them undeclared.
 *
 * THE ABSENCE IS NOT SILENT AT RUNTIME. `resolveRouting` marks an event `deferred` when any declared
 * consumer is not live, and the relay finalizes each row `pending` with `attemptCount - 1` and
 * `nextAttemptAt: now + deferredRetryMs`. The decrement means it never reaches `maxAttempts` and never
 * dead-letters; the retention purge touches only `dispatched` rows. So each emission of a
 * declared-but-unbound event is a row that stays pending forever and is re-claimed every 30 minutes.
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
 *        bun run scripts/check-outbox-bindings.ts --update   (regenerate the deferral event lists)
 * CI:    exits 1 on any disagreement (arch:fitness stage).
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildBootOutboxCatalog } from "../apps/backend/src/bootstrap/outbox-persister";
import { MODULES } from "../architecture/module-manifest";
import type { ModuleEventContribution, OutboxEventEntry } from "../packages/types/src/index";
import { DEFERRED_CONSUMERS, type DeferredConsumerGroup } from "./outbox-deferred-consumers";
import { SUBSCRIPTION_EXCEPTIONS } from "./outbox-subscription-exceptions";

/**
 * Every real module token. `ModuleToken` is the template-literal type `m${number}`, so the compiler
 * accepts `"m99"` — the type's own comment claims declaredConsumers are "validated against real module
 * ids" and nothing was doing that. The manifest is the single source of what modules exist.
 */
const MODULE_TOKENS = new Set(MODULES.map((m) => `m${m.id}`));

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

const DEFERRAL_NAME = "outbox-deferred-consumers.ts";
const DEFERRAL_FILE = join(REPO_ROOT, "scripts", DEFERRAL_NAME);
const updating = process.argv.includes("--update");

interface Pair {
  readonly eventType: string;
  readonly module: string;
}

const pairKey = (eventType: string, module: string): string => `${module}::${eventType}`;

const SUBSCRIPTION_EXCEPTION_NAME = "outbox-subscription-exceptions.ts";
const SUBSCRIPTION_EXCEPTED = new Set(
  SUBSCRIPTION_EXCEPTIONS.flatMap((group) =>
    group.events.map((eventType) => pairKey(eventType, group.module)),
  ),
);
const subscriptionExcepted = (module: string, eventType: string): boolean =>
  SUBSCRIPTION_EXCEPTED.has(pairKey(eventType, module));

/**
 * Rewrite ONLY the `events: [...]` arrays in the register, preserving every hand-written `reason`, and
 * append a stub group for a consumer module that has newly acquired unbound pairs. The stub is written
 * `unclassified` with an EMPTY reason, which fails the gate — `--update` may not create a passing state
 * out of a fact nobody has explained.
 *
 * A MODULE CAN HAVE MULTIPLE GROUPS (F-115 split M30 into `handlers-unbound` and `no-consumer-surface`),
 * and this function used to get both halves of that wrong at once (found running `--update` in #248's
 * F-117 pass). First, the anchor was `module: "${module}",` alone: `indexOf` resolves every group sharing
 * a module name to the SAME first occurrence, so the second group's iteration silently overwrote the
 * first group's just-written block. Anchoring on `module` + `kind` TOGETHER fixes that — it is exact
 * even when a module has several groups, where a bare module search cannot be. Second, and worse: this
 * function has no way to know which of a module's several groups a newly-unbound pair BELONGS to
 * (`unbound` carries no `kind`), so a naive "give the fresh list to whichever group I'm looking at"
 * would guess, and `byModule.delete()` after the first guess made every LATER group for that module come
 * out empty — not a guess, silent data loss. Multi-group modules are therefore never redistributed: each
 * existing group only ever LOSES an event that resolved (is no longer unbound), never gains one it did
 * not already claim, and any newly-unbound pair for that module that no existing group claims surfaces as
 * its own fresh `unclassified` stub (the same mechanism a brand-new module gets) rather than vanishing
 * into one sibling group's list. A single-group module keeps the original full-replace behaviour, since
 * there is no sibling to guess wrong against.
 */
function regenerate(source: string, unbound: readonly Pair[]): string {
  const unboundByModule = new Map<string, Set<string>>();
  for (const { eventType, module } of unbound) {
    const set = unboundByModule.get(module) ?? new Set<string>();
    set.add(eventType);
    unboundByModule.set(module, set);
  }

  const groupCountByModule = new Map<string, number>();
  for (const group of DEFERRED_CONSUMERS) {
    groupCountByModule.set(group.module, (groupCountByModule.get(group.module) ?? 0) + 1);
  }

  let out = source;
  const claimedByModule = new Map<string, Set<string>>();
  for (const group of DEFERRED_CONSUMERS) {
    const stillUnbound = unboundByModule.get(group.module) ?? new Set<string>();
    const isMultiGroup = (groupCountByModule.get(group.module) ?? 0) > 1;
    // Multi-group: only drop what resolved — never adopt an event this group didn't already list,
    // since that would be guessing which sibling group a new pair belongs to. Single-group: the
    // original full-replace, there being no sibling to guess wrong against.
    const events = (isMultiGroup ? group.events.filter((e) => stillUnbound.has(e)) : [...stillUnbound])
      .slice()
      .sort();
    const claimed = claimedByModule.get(group.module) ?? new Set<string>();
    for (const e of events) claimed.add(e);
    claimedByModule.set(group.module, claimed);

    // Anchor on (module, kind) TOGETHER — precise even when a module has multiple groups, unlike a
    // bare module search, which resolves to the same first occurrence for every group sharing it.
    const anchor = out.indexOf(`module: "${group.module}",\n    kind: "${group.kind}",`);
    if (anchor === -1) continue;
    const listStart = out.indexOf("events: [", anchor);
    const blockEnd = out.indexOf("\n  },", anchor);
    if (listStart === -1 || blockEnd === -1 || listStart > blockEnd) continue;
    const listEnd = out.lastIndexOf("]", blockEnd);
    const rendered = events.map((e) => `\n      "${e}",`).join("");
    out = `${out.slice(0, listStart)}events: [${rendered}\n    ${out.slice(listEnd)}`;
  }

  // Leftover: a brand-new module (no existing group at all), OR a newly-unbound pair on a module
  // whose existing group(s) correctly declined to adopt it. Either way it needs a human, not a guess.
  const stubs: string[] = [];
  for (const [module, all] of [...unboundByModule].sort(([a], [b]) => a.localeCompare(b))) {
    const claimed = claimedByModule.get(module) ?? new Set<string>();
    const leftover = [...all].filter((e) => !claimed.has(e)).sort();
    if (leftover.length === 0) continue;
    stubs.push(
      `  {\n    module: "${module}",\n    kind: "unclassified",\n    reason: "",\n    events: [${leftover
        .map((e) => `\n      "${e}",`)
        .join("")}\n    ],\n  },\n`,
    );
  }
  if (stubs.length > 0) {
    out = out.replace(/\n\];\n$/, `\n${stubs.join("")}];\n`);
  }
  return out;
}

/**
 * One module's declaration of what it subscribes to, whatever it is spelled.
 *
 * `constants` carries every exported name the module expresses it through, because the error messages
 * have to say which file to go and edit — F-094's messages hardcoded `M<N>_SUBSCRIBED_EVENT_NAMES`,
 * which was true of the six lists it could see and of none of the thirteen it could not.
 */
export interface SubscriptionList {
  readonly module: string;
  readonly constants: readonly string[];
  readonly events: readonly string[];
}

/** How a module's subscription declaration is written. Four shapes, and the reason each exists. */
type SubscriptionShape =
  /** `readonly string[]` — the six `M<N>_SUBSCRIBED_EVENT_NAMES` tuples, and the `*_TOPICS` splits. */
  | "string[]"
  /** `readonly { eventName, consumerName }[]` — a routing table naming the handler per event. */
  | "{ eventName }[]"
  /** `Record<eventName, effects>` — a frozen topic→effect map the pure handlers read. */
  | "Record<eventName, _>"
  /** A single `{ eventName, consumerName }` — a module with exactly one subscription. */
  | "{ eventName }";

/**
 * Normalise one exported subscription constant to the event names it declares, or `null` when the value
 * is not a subscription declaration at all.
 *
 * `null` is NEVER a skip at the call site. It is an error naming the file and the constant, because the
 * whole defect this rule exists to end is a declaration that no check could see: a fifth shape must fail
 * loudly on the commit that introduces it, not be quietly dropped the way three of these four were.
 */
export function normaliseSubscriptionValue(
  value: unknown,
): { readonly shape: SubscriptionShape; readonly events: readonly string[] } | null {
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return { shape: "string[]", events: value as readonly string[] };
    }
    if (value.every((entry) => isEventNamed(entry))) {
      return { shape: "{ eventName }[]", events: value.map((entry) => entry.eventName) };
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    if (isEventNamed(value)) return { shape: "{ eventName }", events: [value.eventName] };
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((key) => EVENT_NAME.test(key))) {
      return { shape: "Record<eventName, _>", events: keys };
    }
  }
  return null;
}

/** An event name is `<segment>.<segment>[.<segment>…]`, which is what makes a Record's keys recognisable
 *  as topics rather than as the field names of some unrelated config object. */
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

function isEventNamed(value: unknown): value is { readonly eventName: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { eventName?: unknown }).eventName === "string"
  );
}

/** What rule 6 needs to know about one catalogued event. Narrower than `OutboxEventEntry` so the pure
 *  check below can be exercised without building a boot catalog. */
export interface CatalogFacts {
  has(eventType: string): boolean;
  declaredConsumers(eventType: string): readonly string[] | undefined;
}

/**
 * Every subscription-shaped exported constant in the corpus, grouped by the module that owns it.
 *
 * DISCOVERY IS THE WHOLE DEFECT (F-095). F-094 enumerated `M<N>_SUBSCRIBED_EVENT_NAMES` off the
 * `@wardenx/types` barrel and its own comment claimed "a seventh module publishing one is checked the day
 * it lands with no edit here". That was false when it was written: THIRTEEN more modules already declared
 * their subscriptions, under three other spellings and in another directory — `M<N>_OUTBOX_SUBSCRIPTIONS`
 * and `M<N>_UPSTREAM_SUBSCRIPTIONS` under each module's own `consumers` directory, the `_TOPICS` splits,
 * the frozen `_SUBSCRIPTION_MAP`s, and two single-subscription objects. Rule 6 saw six of nineteen, so
 * the gate written to end "a list compared to nothing" left thirteen lists compared to nothing.
 *
 * So the pattern is deliberately wide — any `M<N>_…SUBSCRI…` export — and the narrowing happens on the
 * VALUE, where it can be checked. A name that matches and whose value is not a subscription declaration
 * is an ERROR, not a skip; the one exception is a `*_DEFERRED` boolean, which is a staging FLAG rather
 * than a set of topics and is recognised as such by shape (`typeof value === "boolean"`), never by name
 * alone.
 *
 * A module's constants are UNIONED, not required to agree: M23 splits its eighteen topics into
 * `_LIVE_`/`_DENY_STUB_` halves and M30/M27 derive a `_TOPICS` array from a `_MAP`, so a subset relation
 * between a module's own constants is that module's business. What rule 6 asks is about the module's
 * subscribed set as a whole.
 */
async function discoverSubscriptionLists(): Promise<{
  lists: Map<string, SubscriptionList>;
  errors: string[];
}> {
  const errors: string[] = [];
  const events = new Map<string, Set<string>>();
  const constants = new Map<string, string[]>();
  const declaration = /export\s+const\s+(M(\d+)_[A-Z0-9_]*SUBSCRI[A-Z0-9_]*)\b/g;

  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    const found = [...source.matchAll(declaration)].map((match) => ({
      name: match[1] as string,
      module: `m${Number(match[2])}`,
    }));
    if (found.length === 0) continue;
    const rel = relative(REPO_ROOT, file);
    let namespace: Record<string, unknown>;
    try {
      namespace = (await import(file)) as Record<string, unknown>;
    } catch (err) {
      errors.push(`${rel}: declares a subscription constant but does not import — ${String(err)}`);
      continue;
    }
    for (const { name, module } of new Map(found.map((f) => [f.name, f])).values()) {
      const value = namespace[name];
      // The `*_DEFERRED` staging flag: the module's own record that the binding is not wired yet. It is a
      // boolean, not a topic set, and it is recognised by its VALUE so a list that happened to be named
      // `…_DEFERRED` could never disappear from the check.
      if (typeof value === "boolean" && name.endsWith("_DEFERRED")) continue;
      const normalised = normaliseSubscriptionValue(value);
      if (normalised === null) {
        errors.push(
          `${rel}: '${name}' is subscription-shaped by name and its value is not a subscription declaration (expected string[], { eventName }[], Record<eventName, _>, or { eventName }) — rule 6 cannot check it, and silently skipping it is exactly how thirteen lists went unchecked (F-095). Give it a recognised shape, or rename it so it does not claim to be a subscription.`,
        );
        continue;
      }
      const set = events.get(module) ?? new Set<string>();
      for (const eventName of normalised.events) set.add(eventName);
      events.set(module, set);
      constants.set(module, [...(constants.get(module) ?? []), name]);
    }
  }

  const lists = new Map<string, SubscriptionList>();
  for (const [module, set] of events) {
    lists.set(module, {
      module,
      constants: (constants.get(module) ?? []).sort(),
      events: [...set],
    });
  }
  return { lists, errors };
}

/** A `ReadonlyMap<string, OutboxEventEntry>` as {@link CatalogFacts}. */
export function catalogFactsOf(
  catalog: ReadonlyMap<string, { readonly declaredConsumers: readonly string[] }>,
): CatalogFacts {
  return {
    has: (eventType) => catalog.has(eventType),
    declaredConsumers: (eventType) => catalog.get(eventType)?.declaredConsumers,
  };
}

/**
 * Rule 6, as a pure function: every disagreement between the modules' own subscription lists and the
 * catalog, in BOTH directions, minus the pairs `excepted` names.
 *
 * Extracted so the rule is testable without a boot catalog — the shapes it has to get right (a name in
 * no catalog at all, a name the catalog carries but does not route to this module, and a declaration the
 * module's list omits) are exactly the three the six lists were wrong about.
 */
export function subscriptionDisagreements(
  subscriptionLists: ReadonlyMap<string, SubscriptionList>,
  catalog: CatalogFacts,
  excepted: (module: string, eventType: string) => boolean,
): string[] {
  const failures: string[] = [];
  for (const [module, list] of [...subscriptionLists].sort()) {
    const listName = list.constants.join(" / ");
    const seen = new Set<string>();
    for (const eventType of list.events) {
      if (seen.has(eventType)) failures.push(`${listName}: '${eventType}' is listed twice`);
      seen.add(eventType);
      if (excepted(module, eventType)) continue;
      if (!catalog.has(eventType)) {
        failures.push(
          `${listName}: '${eventType}' is in no boot catalog entry — no module owns or emits it, so the handler behind this name can never run. Catalogue the event (and register its MNN_OUTBOX_EVENTS in ${COMPOSITION_ROOT}), correct the name, drop it, or register the exception in ${SUBSCRIPTION_EXCEPTION_NAME}.`,
        );
        continue;
      }
      const declared = catalog.declaredConsumers(eventType) ?? [];
      if (!declared.includes(module)) {
        failures.push(
          `${listName}: '${eventType}' does not declare '${module}' [${declared.join(", ")}] — the relay routes this event to nobody in ${module}, so a binding for it would deliver nothing. Add '${module}' to declaredConsumers, drop the subscription, or register the exception in ${SUBSCRIPTION_EXCEPTION_NAME}.`,
        );
      }
    }
  }
  return failures;
}

/**
 * The converse half of rule 6: a catalogued event that declares a module whose own subscription list does
 * not name it. Separate from {@link subscriptionDisagreements} because it walks the CATALOG rather than
 * the lists, and because it is the cheap direction to fix — the catalog is what the relay reads, so the
 * list is simply wrong.
 */
export function undeclaredSubscriptions(
  subscriptionLists: ReadonlyMap<string, SubscriptionList>,
  catalogEntries: Iterable<readonly [string, { readonly declaredConsumers: readonly string[] }]>,
  excepted: (module: string, eventType: string) => boolean,
  deferred: (module: string, eventType: string) => boolean,
): string[] {
  const failures: string[] = [];
  const entries = [...catalogEntries];
  for (const [module, list] of [...subscriptionLists].sort()) {
    const listName = list.constants.join(" / ");
    const seen = new Set(list.events);
    for (const [eventType, entry] of entries) {
      if (!entry.declaredConsumers.includes(module)) continue;
      if (seen.has(eventType) || excepted(module, eventType)) continue;
      // ONE ABSENCE, ONE REGISTER. A pair rule 4 already accepted as a registered deferral is the SAME
      // fact seen from the list side: the module is declared, has no binding, and said why in
      // `outbox-deferred-consumers.ts`. Reporting it again here would demand a second reason for the
      // first one, and would make the deferral register's 255 launch-tier entries each need a twin —
      // which is how a register stops being read. When the deferral is lifted by binding the event, this
      // rule starts requiring the list to name it, so the list is corrected on the commit that binds.
      if (deferred(module, eventType)) continue;
      failures.push(
        `catalog: '${eventType}' declares consumer '${module}', which ${listName} does not list — the module's own source of truth and the catalog disagree about whether it subscribes. Add it to the list, drop '${module}' from declaredConsumers, or register the exception in ${SUBSCRIPTION_EXCEPTION_NAME}.`,
      );
    }
  }
  return failures;
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

  // ── rule 5: `seamConsumers` names a real module, and never one that binds (F-043 / #103) ──────
  //
  // `seamConsumers` records a cross-module relationship the OUTBOX does not carry — M4's write-audit
  // triggers, M36's AlertEmitter, M33's MetricsProvider pull. The dispatcher ignores it by
  // construction, which is the point: naming a module there can never defer a row. Precisely because
  // it is inert at runtime, nothing else would notice it going wrong, so it is checked here.
  //
  // The failure this prevents is a module drifting into the seam list to silence a deferral it should
  // have satisfied with a binding. A module that genuinely consumes from the outbox belongs in
  // `declaredConsumers`; being in both is a contradiction about how the event is delivered.
  for (const [eventType, entry] of catalog) {
    const seam = entry.seamConsumers ?? [];
    for (const module of seam) {
      if (!MODULE_TOKENS.has(module)) {
        failures.push(
          `catalog: event '${eventType}' names '${module}' in seamConsumers, which is not a real module id`,
        );
      }
      if (entry.declaredConsumers.includes(module as never)) {
        failures.push(
          `catalog: event '${eventType}' names '${module}' in BOTH declaredConsumers and seamConsumers — an event is delivered to a module by the outbox or by a seam, not both; pick one`,
        );
      }
    }
  }

  // ── rule 4: catalog → binding, the direction rules 1-3 never ran (F-043 / #103) ───────────────
  const boundPairs = new Set<string>();
  for (const binding of bindings) {
    for (const eventType of binding.eventTypes)
      boundPairs.add(pairKey(eventType, binding.consumerModule));
  }

  const unbound: Pair[] = [];
  for (const [eventType, entry] of catalog) {
    for (const module of entry.declaredConsumers) {
      if (!boundPairs.has(pairKey(eventType, module))) unbound.push({ eventType, module });
    }
  }

  if (updating) {
    writeFileSync(DEFERRAL_FILE, regenerate(readFileSync(DEFERRAL_FILE, "utf8"), unbound));
    console.log(
      `Updated ${relative(REPO_ROOT, DEFERRAL_FILE)}: ${unbound.length} deferred (module, event) pair(s).`,
    );
    console.log("Review the diff — a NEW group is written `unclassified` and needs a real reason.");
    return;
  }

  const declaredPairs = new Map<string, DeferredConsumerGroup>();
  for (const group of DEFERRED_CONSUMERS) {
    if (group.reason.trim().length === 0) {
      failures.push(
        `${DEFERRAL_NAME}: group '${group.module}' carries no reason — an unexplained deferral is exactly what this register exists to end`,
      );
    }
    for (const eventType of group.events) {
      const key = pairKey(eventType, group.module);
      if (declaredPairs.has(key)) {
        failures.push(`${DEFERRAL_NAME}: (${group.module}, ${eventType}) is listed twice`);
      }
      declaredPairs.set(key, group);
    }
  }

  const unboundKeys = new Set(unbound.map((p) => pairKey(p.eventType, p.module)));
  for (const { eventType, module } of unbound) {
    if (declaredPairs.has(pairKey(eventType, module))) continue;
    const entry = catalog.get(eventType);
    const remedy = `bind it, drop '${module}' from declaredConsumers (or catalogue the event record-only), or register the deferral in ${DEFERRAL_NAME} with a reason`;
    failures.push(
      `catalog: '${eventType}' declares consumer '${module}' [${entry?.declaredConsumers.join(", ")}] and no live binding from '${module}' exists — ${remedy}. Left as is, every emission of this event is an outbox row that stays pending forever and is re-claimed every 30 minutes.`,
    );
  }

  // ── rule 6: module subscription list ↔ catalog, both ways (F-094 / #205) ─────────────────────
  //
  // DISCOVERY IS BY EVALUATION AND CORPUS-WIDE (F-095). See `discoverSubscriptionLists` for why the
  // types-barrel scan this replaced saw six of nineteen modules. A module that DELETES its list silently
  // stops being checked, which is why `SUBSCRIPTION_EXCEPTIONS` keys on the pair and not on the module.
  const { lists: subscriptionLists, errors: subscriptionErrors } =
    await discoverSubscriptionLists();
  failures.push(...subscriptionErrors);
  if (subscriptionLists.size === 0) {
    failures.push(
      "no M<N>_…SUBSCRI… constant was discovered anywhere in apps/ or packages/ — rule 6 checked nothing, which must not look like a pass",
    );
  }

  // The modules that contribute an `MNN_OUTBOX_EVENTS` catalog to the boot dispatcher. What separates
  // `no-producer` from `no-such-event`: a module with no catalog may yet publish the name, a module with
  // one has already said what it publishes and this is not among it.
  const catalogContributors = new Set(
    bootCatalogContributionNames().map((name) => `m${Number(/^M(\d+)_/.exec(name)?.[1] ?? 0)}`),
  );

  const deferredPair = (module: string, eventType: string): boolean =>
    declaredPairs.has(pairKey(eventType, module));

  failures.push(
    ...subscriptionDisagreements(subscriptionLists, catalogFactsOf(catalog), subscriptionExcepted),
  );
  failures.push(
    ...undeclaredSubscriptions(subscriptionLists, catalog, subscriptionExcepted, deferredPair),
  );

  // An exception that has been reconciled must not outlive its reason — the deferral register's rule,
  // applied to the register that lets a divergence be deliberate.
  const seenExceptions = new Set<string>();
  for (const group of SUBSCRIPTION_EXCEPTIONS) {
    if (group.reason.trim().length === 0) {
      failures.push(
        `${SUBSCRIPTION_EXCEPTION_NAME}: group (${group.module}, ${group.kind}) carries no reason — an unexplained exception is exactly what this register exists to end`,
      );
    }
    const subscribed = subscriptionLists.get(group.module);
    for (const eventType of group.events) {
      const key = pairKey(eventType, group.module);
      if (seenExceptions.has(key)) {
        failures.push(
          `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is listed twice`,
        );
      }
      seenExceptions.add(key);
      if (!subscribed) {
        failures.push(
          `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) names a module that publishes no subscription list — delete the entry`,
        );
        continue;
      }
      const listed = subscribed.events.includes(eventType);
      const declared = catalog.get(eventType)?.declaredConsumers.includes(group.module as never);
      if (listed && declared === true) {
        failures.push(
          `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is now both subscribed and declared — the exception has outlived its reason; delete the entry`,
        );
      }
      // WHICH DIVERGENCE THE ENTRY EXCUSES DECIDES WHAT WOULD END IT. Every kind but one excuses a name
      // the module LISTS and the catalog does not route to it, so the entry dies when the list drops it.
      // `self-consumption` excuses the opposite — the catalog DECLARES the module and the module's
      // inbound-only map correctly stays silent — so requiring it to be listed would demand exactly the
      // entry it exists to say is wrong.
      if (group.kind === "self-consumption") {
        if (listed) {
          failures.push(
            `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is classed 'self-consumption' and IS listed in ${subscribed.constants.join(" / ")} — the divergence it excuses is gone; delete the entry`,
          );
        }
        if (declared !== true) {
          failures.push(
            `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is classed 'self-consumption' and the catalog no longer declares '${group.module}' — there is nothing left to except; delete the entry`,
          );
        }
        if (!eventType.startsWith(`${group.module}.`)) {
          failures.push(
            `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is classed 'self-consumption' but the event is not '${group.module}'-owned — that kind states one checkable fact and this is not it`,
          );
        }
        continue;
      }
      if (!listed) {
        failures.push(
          `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is no longer in ${subscribed.constants.join(" / ")} — there is no divergence left to except; delete the entry`,
        );
      }
      // TWO WAYS TO NAME AN EVENT NO CATALOG CARRIES, AND THEY END DIFFERENTLY. `no-producer` says the
      // OWNING module contributes no catalog at all (M2, M28 and M36 today), so the name may yet become
      // real when that module catalogues its events. `no-such-event` says the owning module HAS a landed
      // catalog and this is not in it, so waiting will not fix it — the name was never right. Getting
      // these the wrong way round is how a permanent defect gets filed as a staging gap, so the gate
      // decides which one is true rather than trusting the entry.
      if (!catalog.has(eventType)) {
        const owner = eventType.slice(0, eventType.indexOf("."));
        const ownerContributes = catalogContributors.has(owner);
        const truth = ownerContributes ? "no-such-event" : "no-producer";
        if (group.kind !== truth) {
          failures.push(
            `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is classed '${group.kind}' but the boot catalog does not carry the event and '${owner}' ${ownerContributes ? "DOES contribute a catalog — that is 'no-such-event'" : "contributes no catalog at all — that is 'no-producer'"}`,
          );
        }
      } else if (group.kind === "no-producer" || group.kind === "no-such-event") {
        failures.push(
          `${SUBSCRIPTION_EXCEPTION_NAME}: (${group.module}, ${eventType}) is classed '${group.kind}' but the boot catalog now carries it — the blocker has lifted; declare the consumer or reclassify the entry`,
        );
      }
    }
  }

  // An entry that gained a binding, or whose event/declaration went away, must not outlive its reason.
  for (const group of DEFERRED_CONSUMERS) {
    for (const eventType of group.events) {
      const entry = catalog.get(eventType);
      if (!entry) {
        failures.push(
          `${DEFERRAL_NAME}: (${group.module}, ${eventType}) names an event the boot catalog does not carry — delete the entry`,
        );
        continue;
      }
      if (!entry.declaredConsumers.includes(group.module as never)) {
        failures.push(
          `${DEFERRAL_NAME}: (${group.module}, ${eventType}) — '${group.module}' is no longer in declaredConsumers, so the deferral has nothing to defer; delete the entry`,
        );
        continue;
      }
      if (!unboundKeys.has(pairKey(eventType, group.module))) {
        failures.push(
          `${DEFERRAL_NAME}: (${group.module}, ${eventType}) is bound live now — the deferral has outlived its reason; delete the entry (\`--update\` rewrites the lists)`,
        );
      }
    }
  }

  const boundEvents = new Set(bindings.flatMap((b) => b.eventTypes));
  console.log(
    `Outbox bindings: ${bindings.length} live binding(s) across ${sites.length} file(s), ` +
      `covering ${boundEvents.size} of ${catalog.size} catalogued event(s).`,
  );
  const byKind = new Map<string, number>();
  for (const group of DEFERRED_CONSUMERS) {
    byKind.set(group.kind, (byKind.get(group.kind) ?? 0) + group.events.length);
  }
  const kindSummary = [...byKind.entries()]
    .sort()
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  console.log(
    `Declared-but-unbound: ${unbound.length} (module, event) pair(s) across ${DEFERRED_CONSUMERS.length} consumer module(s) — ${kindSummary}`,
  );
  // The `deviceAttestationValid` rule, as check-context-attributes.ts applies it: a declared absence
  // with no established reason is the STANDING FINDING, printed every run, not a passing state.
  const unclassified = DEFERRED_CONSUMERS.filter((g) => g.kind === "unclassified");
  if (unclassified.length > 0) {
    console.log(
      `\n  ⚠ ${unclassified.length} consumer module(s) deferred with NO established reason (#103):`,
    );
    for (const group of unclassified) {
      console.log(`      · ${group.module} — ${group.events.length} event(s)`);
    }
  }

  // Rule 6's standing finding (F-094 / #205), printed every run for the same reason: a subscription the
  // relay routes to nobody is a handler that can never fire, and an excepted one is still that.
  const exceptionsByKind = new Map<string, number>();
  for (const group of SUBSCRIPTION_EXCEPTIONS) {
    exceptionsByKind.set(group.kind, (exceptionsByKind.get(group.kind) ?? 0) + group.events.length);
  }
  const exceptionCount = [...exceptionsByKind.values()].reduce((a, b) => a + b, 0);
  const subscribedCount = [...subscriptionLists.values()].reduce(
    (total, list) => total + list.events.length,
    0,
  );
  console.log(
    `Subscription lists: ${subscriptionLists.size} module(s) via ${[...subscriptionLists.values()].reduce((n, l) => n + l.constants.length, 0)} constant(s), ${subscribedCount} subscribed name(s), ` +
      `${exceptionCount} not routed by the catalog — ` +
      `${[...exceptionsByKind.entries()]
        .sort()
        .map(([kind, n]) => `${kind} ${n}`)
        .join(", ")}`,
  );
  const noProducer = SUBSCRIPTION_EXCEPTIONS.filter((g) => g.kind === "no-producer");
  if (noProducer.length > 0) {
    const owners = new Set(
      noProducer.flatMap((g) => g.events.map((e) => e.slice(0, e.indexOf(".")))),
    );
    console.log(
      `\n  ⚠ ${noProducer.reduce((n, g) => n + g.events.length, 0)} subscribed name(s) have NO PRODUCER (#205) — ` +
        `${[...owners].sort().join(", ")} contribute no event catalog to the boot dispatcher:`,
    );
    for (const group of noProducer) {
      console.log(`      · ${group.module} — ${group.events.join(", ")}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} outbox binding/catalog disagreement(s):\n`);
    for (const failure of failures) console.error(`  · ${failure}`);
    console.error(
      "\nRules 1-5 are what the outbox dispatcher throws on at boot, before server.listen(); rule 6 is\n" +
        "what silently routes an event to nobody. Fix the catalog entry (events-by-mNN.ts), the binding,\n" +
        "or the module's own subscription list — do not relax this gate.",
    );
    process.exit(1);
  }
  console.log(
    "✓ every live outbox binding agrees with the boot event catalog, every declared consumer is bound or registered as deferred, and every subscription list agrees with the catalog both ways.",
  );
}

// Guarded so the pure rule-6 helpers above can be imported by `scripts/__tests__/` without running the
// whole gate as an import side effect (the `check-live-suite-coverage.ts` convention).
if (import.meta.main) await main();
