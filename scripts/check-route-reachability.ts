/**
 * WardenX — Route-reachability check  (F-090; fitness gate)
 * ---------------------------------------------------------
 * Every function that registers an HTTP route must be REACHED from the composition root.
 *
 * This closes the gap F-029 left explicitly open. That finding fixed `attributes.stepUpRecent` so the
 * step-up FACT reached the fifteen modules that read it, and then found the column it resolves from —
 * `session.last_step_up_at` — was written by nobody: `registerSessionStepUpRoutes` shipped with
 * production-shaped adapters and exactly one caller, its own test. Every step-up gate on the platform
 * answered "not fresh" for every caller, forever. The routes nonetheless appeared in the published
 * OpenAPI contract, because `scripts/openapi/scan-routes.ts` reads SOURCE and cannot tell a mounted
 * route from an unmounted one — so the contract advertised a surface that returned 404.
 *
 * F-029's own write-up names both the gate needed and the trap in the obvious cheap version:
 *
 *     "a route can still be in the published contract and mounted by nothing — the reachability
 *      analysis a gate would need is a call graph from the composition root, and the obvious cheap
 *      proxy (is the registrar referenced anywhere?) would NOT have caught this one, since M2's
 *      index re-exported it."
 *
 * So the whole difficulty is one distinction: a barrel's `export { registerFooRoutes } from "./foo"`
 * is a REFERENCE and not an EXECUTION. Grep cannot tell those apart; the AST can, because a re-export
 * is an `ExportDeclaration` and the name inside it is an `ExportSpecifier` — a node kind that never
 * appears in executable code. This walks the TypeScript syntax tree and skips exactly that node kind,
 * which is why it reports the two surfaces the grep proxy calls mounted.
 *
 * Syntax-only (`ts.createSourceFile`, no type checker, no `createProgram`) so it runs in well under a
 * second, like the other `arch:fitness` gates. Identifier→declaration resolution is therefore
 * name-based within a file's own scope plus its relative imports, which is sound for this codebase's
 * one-symbol-per-name convention and is checked by the reconciliation below.
 *
 * Run:   bun run scripts/check-route-reachability.ts
 * CI:    exits 1 on any unreached registrar that is not a registered deferral.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = process.cwd();
const BACKEND_SRC = "apps/backend/src";
const COMPOSITION_ROOT = `${BACKEND_SRC}/index.ts`;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Route surfaces that are deliberately NOT mounted, each with the reason and what it needs.
 *
 * The `deviceAttestationValid` rule, at route-surface granularity: a surface that genuinely cannot be
 * mounted yet is a REGISTERED absence carrying its blocker, never an unmatched name — both are
 * unreachable, only the first is distinguishable from a mistake. An entry that gains a mount FAILS
 * ("outlived its reason"), and an entry whose registrar no longer exists FAILS, so the list cannot go
 * stale in either direction.
 */
const DEFERRED: readonly { file: string; registrar: string; reason: string }[] = [
  // GAP-101 closed the last entry: M36's `registerMessagingWebhookRoutes` is mounted through
  // `mountMessagingWebhookRoutes` (36-messaging/delivery/webhook-mount.ts) over a real delivery-reconcile service.
];

// ---- file discovery -------------------------------------------------------
const files: string[] = [];
(function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "dist" || entry === "__tests__" || entry === "node_modules") continue;
      walk(full);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.includes(".test.")) files.push(full);
  }
})(BACKEND_SRC);

const sources = new Map<string, ts.SourceFile>();
for (const f of files) {
  sources.set(
    f,
    ts.createSourceFile(f, readFileSync(join(REPO_ROOT, f), "utf8"), ts.ScriptTarget.ES2022, true),
  );
}

/** Resolve a RELATIVE import specifier to a file in the scanned set (`./x` → `./x.ts` | `./x/index.ts`). */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(join(REPO_ROOT, fromFile)), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    const rel = relative(REPO_ROOT, candidate);
    if (sources.has(rel)) return rel;
  }
  return null;
}

interface Sym {
  readonly file: string;
  readonly name: string;
}
const symKey = (s: Sym): string => `${s.file}#${s.name}`;

// ---- per-file indexes -----------------------------------------------------
/** Top-level function-like declarations, by name → the node whose body is the function's code. */
const declarations = new Map<string, Map<string, ts.Node>>();
/** `import { a as b } from "./x"` → local name `b` resolves to `{ file: x, name: a }`. */
const imports = new Map<string, Map<string, Sym>>();
/** `export { a as b } from "./x"` / `export * from "./x"` — symbol resolution ONLY, never an edge. */
const reexports = new Map<string, { local: string; target: Sym }[]>();

function functionBodyOf(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.body ?? null;
  if (ts.isVariableStatement(node)) {
    for (const d of node.declarationList.declarations) {
      const init = d.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init.body;
    }
  }
  return null;
}

for (const [file, sf] of sources) {
  const decls = new Map<string, ts.Node>();
  const imp = new Map<string, Sym>();
  const rex: { local: string; target: Sym }[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body)
      decls.set(stmt.name.text, stmt.body);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (!init || !ts.isIdentifier(d.name)) continue;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          decls.set(d.name.text, init.body);
      }
    }
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveSpecifier(file, stmt.moduleSpecifier.text);
      const bindings = stmt.importClause?.namedBindings;
      if (target && bindings && ts.isNamedImports(bindings))
        for (const el of bindings.elements)
          imp.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
    }
    // A re-export is where the cheap proxy goes wrong. Recorded for symbol resolution, never walked.
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const target = resolveSpecifier(file, stmt.moduleSpecifier.text);
      if (!target) continue;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements)
          rex.push({
            local: el.name.text,
            target: { file: target, name: (el.propertyName ?? el.name).text },
          });
      } else if (!stmt.exportClause) {
        rex.push({ local: "*", target: { file: target, name: "*" } });
      }
    }
  }
  declarations.set(file, decls);
  imports.set(file, imp);
  reexports.set(file, rex);
}

/** Where does the name `name`, as written in `file`, actually come from? */
function resolveName(file: string, name: string, seen = new Set<string>()): Sym | null {
  const k = `${file}#${name}`;
  if (seen.has(k)) return null;
  seen.add(k);
  if (declarations.get(file)?.has(name)) return { file, name };
  const imported = imports.get(file)?.get(name);
  if (imported) return resolveName(imported.file, imported.name, seen) ?? imported;
  for (const r of reexports.get(file) ?? []) {
    if (r.local === name) return resolveName(r.target.file, r.target.name, seen) ?? r.target;
    if (r.local === "*") {
      const hit = resolveName(r.target.file, name, seen);
      if (hit) return hit;
    }
  }
  return null;
}

// ---- reachability ---------------------------------------------------------
const reached = new Set<string>();
const filesEntered = new Set<string>();
const queue: Sym[] = [];

/** Every identifier in `node` that resolves to a declaration, as an execution edge. */
function walkForEdges(file: string, node: ts.Node): void {
  const visit = (n: ts.Node): void => {
    // The one node kind that is a reference without being an execution.
    if (ts.isExportSpecifier(n) || ts.isImportSpecifier(n) || ts.isExportDeclaration(n)) return;
    if (ts.isIdentifier(n)) {
      const sym = resolveName(file, n.text);
      if (sym && !reached.has(symKey(sym))) {
        reached.add(symKey(sym));
        queue.push(sym);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
}

/** A file's top-level executable statements run when the module is first imported by reached code. */
function enterFile(file: string): void {
  if (filesEntered.has(file)) return;
  filesEntered.add(file);
  const sf = sources.get(file);
  if (!sf) return;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt)) continue; // a declaration is not a call
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) continue;
    walkForEdges(file, stmt);
  }
}

enterFile(COMPOSITION_ROOT);
while (queue.length > 0) {
  const sym = queue.shift() as Sym;
  enterFile(sym.file);
  const body = declarations.get(sym.file)?.get(sym.name);
  if (body) walkForEdges(sym.file, body);
}

// ---- route registrars -----------------------------------------------------
/** `<anything>.get("/path", …)` — the receiver name varies (app / server / instance). */
function routeCallCount(body: ts.Node): number {
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHODS.has(node.expression.name.text) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0] as ts.Node) &&
      // A route path always starts with "/" — `answers.get("Z0350")` on a Map is not a route.
      (node.arguments[0] as ts.StringLiteral).text.startsWith("/")
    )
      n++;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return n;
}

interface Registrar extends Sym {
  readonly routes: number;
}
const registrars: Registrar[] = [];
for (const [file, decls] of declarations)
  for (const [name, body] of decls) {
    const routes = routeCallCount(body);
    if (routes > 0) registrars.push({ file, name, routes });
  }

// ---- verdict --------------------------------------------------------------
const deferredKey = new Set(DEFERRED.map((d) => `${d.file}#${d.registrar}`));
const errors: string[] = [];

const unreached = registrars.filter((r) => !reached.has(symKey(r)));
for (const r of unreached) {
  if (deferredKey.has(symKey(r))) continue;
  errors.push(
    `${r.file}\n    '${r.name}' registers ${r.routes} route(s) and is never reached from ${COMPOSITION_ROOT}.\n    Those paths are in the published contract (scan-routes.ts reads SOURCE) and answer 404.\n    Mount it from the composition root, or register it in DEFERRED with the reason it cannot be.`,
  );
}
// An entry cannot outlive its reason, and cannot survive its registrar.
for (const d of DEFERRED) {
  const found = registrars.find((r) => symKey(r) === `${d.file}#${d.registrar}`);
  if (!found) {
    errors.push(
      `${d.file}\n    DEFERRED names '${d.registrar}', which registers no routes there any more.\n    Remove the entry.`,
    );
    continue;
  }
  if (reached.has(symKey(found)))
    errors.push(
      `${d.file}\n    DEFERRED names '${d.registrar}', but it IS now mounted — the entry has outlived its reason.\n    Remove it.`,
    );
  if (!d.reason.trim())
    errors.push(`${d.file}\n    DEFERRED entry '${d.registrar}' has no reason.`);
}

if (errors.length > 0) {
  console.error(`✗ route-reachability: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  ${e}\n`);
  process.exit(1);
}

const deferredRoutes = DEFERRED.reduce(
  (n, d) => n + (registrars.find((r) => symKey(r) === `${d.file}#${d.registrar}`)?.routes ?? 0),
  0,
);
console.log(
  `✓ route-reachability: ${registrars.length - DEFERRED.length} registrar(s) reached from the ` +
    `composition root${DEFERRED.length > 0 ? `; ${DEFERRED.length} deferred (${deferredRoutes} route(s))` : ""}`,
);
for (const d of DEFERRED) console.log(`    deferred: ${d.registrar} — ${d.reason.slice(0, 96)}…`);
