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
const anyOf = (paths) =>
  `(${paths
    .map(p)
    .map((r) => r.slice(1))
    .join("|")})`;

// ---- Generated module-boundary rules -------------------------------------
const moduleBoundaryRules = MODULES.map((m) => {
  const allowed = allowedImportPaths(m.id);
  return {
    name: `module-${m.id}-boundary`,
    comment: `Module ${m.id} (${m.name}) may import only its own code, its declared dependsOn modules, and the shared leaves. Reaching across an undeclared boundary is forbidden — extend the module's dependsOn in the manifest (a deliberate architecture change), never reach through.`,
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
  comment: `Vendor SDK '${pkg}' may be imported only inside ${owner} (adapter mandate, ARCHITECTURE §25.14). Everything else depends on the adapter's typed interface.`,
  severity: "error",
  from: { pathNot: p(owner) },
  to: {
    dependencyTypes: ["npm"],
    path: `node_modules/${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`,
  },
}));

// ---- Generated helper-only-table rules -----------------------------------
const helperTableRules = Object.entries(HELPER_ONLY_TABLES).map(([table, where]) => ({
  name: `helper-only-table-${table}`,
  comment: `Table '${table}' is written only via ${where}. Direct schema import is forbidden outside the owning helper package.`,
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
          "packages/db",
          "packages/auth",
          "packages/audit",
          "packages/tenancy",
          "packages/messaging",
          "packages/fhir",
          "packages/dosespot",
          "packages/saas-tenant-platform",
          "packages/ai-platform",
          "packages/billing",
          "packages/cost-report",
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
    {
      name: "ui-core-renderer-free",
      comment:
        "packages/ui/src/core is the react-dom-free shared layer (ADR-0035): typed API client, " +
        "context providers, hooks, theme tokens, and native-capability ports. It may NOT import " +
        "the web rendering layer (packages/ui/src/web), so it stays usable by the Capacitor native " +
        "build (and a future React Native consumer) without pulling in React DOM.",
      severity: "error",
      from: { path: p("packages/ui/src/core") },
      to: { path: p("packages/ui/src/web") },
    },
    {
      name: "no-direct-m34-schema-import-from-other-modules",
      comment:
        "Other modules must consume M34 (SaaS Tenant Platform) via its published seams, never " +
        "by reaching into its schema directly. M34's Drizzle tables live in the central barrel " +
        "(packages/db/src/schema/saas) per repo convention; only M34's own logic package and the " +
        "db barrel itself may import them. (M34 spec §13.)",
      severity: "error",
      from: {
        pathNot: anyOf([
          "packages/saas-tenant-platform",
          "packages/db",
          "apps/backend/src/modules/34-saas-tenant-platform",
        ]),
      },
      to: { path: p("packages/db/src/schema/saas") },
    },
    {
      name: "no-m34-import-of-clinical-schemas",
      comment:
        "M34 is the platform control plane; it may not import clinical/PHI schemas (M5–M20). It " +
        "references patient-scoped data only through seams and DSAR/export fulfilment adapters. " +
        "Clinical Drizzle tables live in the central barrel under their per-module schema dirs. " +
        "(M34 spec §13.)",
      severity: "error",
      from: { path: p("packages/saas-tenant-platform") },
      to: {
        path: anyOf([
          "packages/db/src/schema/patient",
          "packages/db/src/schema/admission",
          "packages/db/src/schema/care-plan",
          "packages/db/src/schema/encounter",
          "packages/db/src/schema/assessment",
          "packages/db/src/schema/orders",
          "packages/db/src/schema/dosespot",
          "packages/db/src/schema/emar",
          "packages/db/src/schema/hope",
          "packages/db/src/schema/idg",
          "packages/db/src/schema/evv",
          "packages/db/src/schema/scheduling",
        ]),
      },
    },
    {
      name: "no-direct-m33-schema-import-from-other-modules",
      comment:
        "Other modules must consume M33 (Reporting & Dashboards) via its published seams, never " +
        "by reaching into its schema directly. M33's Drizzle tables live in the central barrel " +
        "(packages/db/src/schema/reporting) per repo convention; only M33's own logic package and " +
        "the db barrel itself may import them. (M33 spec §13.)",
      severity: "error",
      from: {
        pathNot: anyOf([
          "packages/reporting",
          "packages/db",
          "apps/backend/src/modules/33-reporting",
        ]),
      },
      to: { path: p("packages/db/src/schema/reporting") },
    },
    {
      name: "no-m33-import-of-clinical-schemas",
      comment:
        "M33 is a read-only analytics consumer: it aggregates clinical + revenue data exclusively " +
        "through the owning modules' read seams / repositories, never by reaching into their PHI " +
        "schemas directly. Clinical Drizzle tables live in the central barrel under their per-module " +
        "schema dirs. (M33 spec §13.)",
      severity: "error",
      from: {
        path: anyOf(["packages/reporting", "apps/backend/src/modules/33-reporting"]),
      },
      to: {
        path: anyOf([
          "packages/db/src/schema/patient",
          "packages/db/src/schema/admission",
          "packages/db/src/schema/care-plan",
          "packages/db/src/schema/encounter",
          "packages/db/src/schema/assessment",
          "packages/db/src/schema/orders",
          "packages/db/src/schema/dosespot",
          "packages/db/src/schema/emar",
          "packages/db/src/schema/hope",
          "packages/db/src/schema/idg",
          "packages/db/src/schema/evv",
          "packages/db/src/schema/scheduling",
        ]),
      },
    },
    {
      name: "m23-billing-no-ai-platform",
      comment:
        "M23 (Billing — Medicare) §D13 AI-BLOCK: the Medicare-FFS billing record is a billing-fraud " +
        "surface under OIG / UPIC / RAC scrutiny, so the AI block is absolute. Neither the @wardenx/billing " +
        "domain nor the M23 backend module may import the AI platform package or the Anthropic SDK directly — " +
        "Module 32 cannot create, modify, witness, or resolve any billing row. The only AI surface M23 admits " +
        "is the read-only validation_ai_advisory projection (a typed seam, never a direct ai-platform import). " +
        "(M23 spec D13 / §8.6.)",
      severity: "error",
      from: {
        path: anyOf(["packages/billing", "apps/backend/src/modules/23-billing-medicare"]),
      },
      to: {
        path: anyOf(["packages/ai-platform"]),
      },
    },
    {
      name: "m23-billing-no-anthropic-sdk",
      comment:
        "M23 (Billing — Medicare) §D13 AI-BLOCK: @wardenx/billing and the M23 backend module may not import " +
        "the @anthropic-ai/sdk vendor package — no module under the AI block may call an LLM SDK directly. " +
        "(M23 spec D13 / §8.6.)",
      severity: "error",
      from: {
        path: anyOf(["packages/billing", "apps/backend/src/modules/23-billing-medicare"]),
      },
      to: {
        dependencyTypes: ["npm"],
        path: "node_modules/@anthropic-ai/sdk(/|$)",
      },
    },
    {
      name: "no-m29-schema-import-from-other-modules",
      comment:
        "Other modules must consume M29 (External Interfaces) HL7/lab data via its five published seams " +
        "(LabObservationReader, etc.), never by reaching into its schema directly — not even a module that " +
        "declares M29 in dependsOn (M22/M28 consume LabObservationReader; the seam is the only door). M29's " +
        "Drizzle tables live in the central barrel (packages/db/src/schema/external-interfaces) per repo " +
        "convention; only M29's own logic and the db barrel itself may import them. (M29 spec §8.5.4/§13.2.)",
      severity: "error",
      from: {
        pathNot: anyOf(["packages/db", "apps/backend/src/modules/29-external-interfaces"]),
      },
      to: { path: p("packages/db/src/schema/external-interfaces") },
    },
    {
      name: "no-m29-import-of-cross-module-schemas",
      comment:
        "M29 is a textbook adapter-mandate consumer (ARCHITECTURE §25.14): every cross-module read flows " +
        "through a published seam or the M4 outbox, never a direct cross-schema SELECT. It declares M5 " +
        "(patient) and M11 (orders) in dependsOn, but reads patient identity via the PatientReader seam and " +
        "consumes order intent via the m11.order.hl7_orm_requested outbox event — so it may not import their " +
        "Drizzle schemas directly. (M29 spec §8.5.4/§13.2.)",
      severity: "error",
      from: { path: p("apps/backend/src/modules/29-external-interfaces") },
      to: {
        path: anyOf([
          "packages/db/src/schema/patient",
          "packages/db/src/schema/admission",
          "packages/db/src/schema/care-plan",
          "packages/db/src/schema/encounter",
          "packages/db/src/schema/assessment",
          "packages/db/src/schema/orders",
          "packages/db/src/schema/dosespot",
          "packages/db/src/schema/emar",
          "packages/db/src/schema/hope",
          "packages/db/src/schema/idg",
          "packages/db/src/schema/evv",
          "packages/db/src/schema/scheduling",
          "packages/db/src/schema/mdm",
        ]),
      },
    },
    {
      name: "no-direct-xero-gusto-import-from-m29",
      comment:
        "M29 must consume the Xero GL / Gusto payroll surfaces via the XeroClientFactory / GustoClientFactory " +
        "seams M27 publishes (deferred to Phase 2), never by importing the M27-owned adapter packages " +
        "directly. M29 does not declare M27 in dependsOn — the accounting integration is a cross-phase item. " +
        "(M29 spec §8.5.1/§13.2.)",
      severity: "error",
      from: { path: p("apps/backend/src/modules/29-external-interfaces") },
      to: { path: anyOf(["packages/xero-client", "packages/gusto-client"]) },
    },
    ...vendorRules,
    ...helperTableRules,
    ...moduleBoundaryRules,
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    // Generated artifacts are not source. Bundlers emit code-split chunks that legitimately reference
    // each other, and coverage instrumentation rewrites imports; neither is an architecture signal.
    // These paths are gitignored but depcruise walks the filesystem, so exclude them explicitly.
    exclude: { path: "(^|/)(storybook-static|dist|coverage)(/|$)" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require"] },
    reporterOptions: {
      // `err` reporter in CI; `dot`/`archi` for a visual graph in `bun run arch:graph`
      dot: { collapsePattern: "^(apps|packages)/[^/]+" },
    },
  },
};
