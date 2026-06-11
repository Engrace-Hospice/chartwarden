/**
 * WardenX — dependency-cruiser configuration
 * ------------------------------------------------------------------
 * Turns the module catalog's dependency graph + the architecture's
 * structural rules into CI-enforced import boundaries.
 *
 * Run:   bunx depcruise apps packages --config .dependency-cruiser.cjs
 * CI:    fails the build on any `error`-severity violation.
 *
 * Static rules (hand-written below):
 *   1. no-circular            — cycles are forbidden
 *   2. domain-is-pure         — packages/domain may not import I/O or app packages
 *   3. fhir-direction         — packages/domain may not import packages/fhir
 *   4. leaves-stay-leaves     — shared/types/domain/ui may not import feature pkgs
 *   5. vendor-adapter-mandate — vendor SDKs only inside their adapter package
 *   6. no-direct-helper-table — no direct import of audit_event/outbox/idempotency schema
 *
 * Generated rules (from module-manifest.ts):
 *   7. module-boundaries      — module code may only import its deps + leaves
 *
 * NOTE: this file is .cjs so it can require() the compiled manifest. In a Bun/TS
 * repo, point `require` at the transpiled manifest or use a tiny loader; the shape
 * used here (MODULES, allowedImportPaths, VENDOR_ADAPTERS, HELPER_ONLY_TABLES) is
 * what matters.
 */

const {
  MODULES,
  VENDOR_ADAPTERS,
  HELPER_ONLY_TABLES,
  allowedImportPaths,
} = require("./module-manifest.cjs"); // sibling in architecture/ (transpiled from module-manifest.ts)

/** pathToRegex: 'packages/auth/src/rbac' -> '^packages/auth/src/rbac(/|$)' */
const p = (path) => `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`;
const anyOf = (paths) => `(${paths.map(p).map((r) => r.slice(1)).join("|")})`;

// ---- Generated module-boundary rules -------------------------------------
const moduleBoundaryRules = MODULES.map((m) => {
  const allowed = allowedImportPaths(m.id);
  return {
    name: `module-${m.id}-boundary`,
    comment:
      `Module ${m.id} (${m.name}) may import only its own code, its declared ` +
      `dependsOn modules, and the shared leaves. Reaching across an undeclared ` +
      `boundary is forbidden — extend the module's dependsOn in the manifest ` +
      `(a deliberate architecture change), never reach through.`,
    severity: "error",
    from: { path: anyOf(m.codePaths) },
    to: {
      // forbid imports into any workspace path that is NOT in the allowed set
      path: "^(apps|packages)/",
      pathNot: anyOf(allowed),
    },
  };
});

// ---- Generated vendor-adapter rules --------------------------------------
const vendorRules = Object.entries(VENDOR_ADAPTERS).map(([pkg, owner]) => ({
  name: `vendor-adapter-${pkg.replace(/[^a-z0-9]/gi, "-")}`,
  comment:
    `Vendor SDK '${pkg}' may be imported only inside ${owner} (adapter mandate, ` +
    `ARCHITECTURE §25.14). Everything else depends on the adapter's typed interface.`,
  severity: "error",
  from: { pathNot: p(owner) },
  to: { dependencyTypes: ["npm"], path: `node_modules/${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)` },
}));

// ---- Generated helper-only-table rules -----------------------------------
const helperTableRules = Object.entries(HELPER_ONLY_TABLES).map(([table, where]) => ({
  name: `helper-only-table-${table}`,
  comment:
    `Table '${table}' is written only via ${where}. Direct schema import is ` +
    `forbidden outside the owning helper package.`,
  severity: "error",
  from: { pathNot: anyOf(["packages/audit", "packages/shared", "packages/db"]) },
  to: { path: `^packages/db/src/schema/.*${table}` },
}));

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Cyclic dependencies break independent build/test/reasoning.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-is-pure",
      comment:
        "packages/domain is pure types + invariants: no DB, no Fastify, no vendor " +
        "clients, no node I/O. Domain is the dependency floor everyone can import.",
      severity: "error",
      from: { path: p("packages/domain") },
      to: {
        path: anyOf([
          "packages/db", "packages/auth", "packages/audit", "packages/tenancy",
          "packages/messaging", "packages/fhir", "packages/dosespot", "packages/saas",
          "packages/ai-platform", "packages/billing", "packages/cost-report",
        ]),
      },
    },
    {
      name: "domain-no-node-io",
      comment: "packages/domain may not touch node I/O builtins.",
      severity: "error",
      from: { path: p("packages/domain") },
      to: { dependencyTypes: ["core"], path: "^(fs|net|http|https|child_process|dgram|tls)$" },
    },
    {
      name: "fhir-direction",
      comment:
        "Dependency direction is fixed: FHIR mappers import the domain; the domain " +
        "NEVER imports FHIR (ARCHITECTURE §9). FHIR is a representation, not the source of truth.",
      severity: "error",
      from: { path: p("packages/domain") },
      to: { path: p("packages/fhir") },
    },
    {
      name: "leaves-stay-leaves",
      comment:
        "shared/types/ui are leaves: they may not import feature/domain-area packages " +
        "(otherwise everyone transitively depends on everything).",
      severity: "error",
      from: { path: anyOf(["packages/shared", "packages/types", "packages/ui"]) },
      to: {
        path: "^(apps|packages)/",
        pathNot: anyOf(["packages/shared", "packages/types", "packages/ui"]),
      },
    },
    ...vendorRules,
    ...helperTableRules,
    ...moduleBoundaryRules,
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require"] },
    reporterOptions: {
      // `err` reporter in CI; `dot`/`archi` for a visual graph in `bun run arch:graph`
      dot: { collapsePattern: "^(apps|packages)/[^/]+" },
    },
  },
};
