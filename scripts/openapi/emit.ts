/**
 * WardenX — OpenAPI contract generator (F0-T01, ADR-0032)
 * -------------------------------------------------------
 * Assembles docs/api/openapi.json from the auto-discovered backend routes
 * (scan-routes.ts) + the schema-enrichment registry (enrichments.ts). This file
 * is the FRONTEND CONTRACT SOURCE OF TRUTH until the backend routes are wired to
 * Fastify's `schema:` option (deferred follow-up; see FRONTEND_INTEGRATION_PLAN.md).
 * The typed client (packages/ui/src/api) is generated from the JSON this writes.
 *
 * Usage:
 *   bun run scripts/openapi/emit.ts            (alias: bun run openapi:emit)  — writes the file
 *   bun run scripts/openapi/emit.ts --check    (alias: bun run openapi:check) — CI: no write, fails on drift
 *
 * CI FAILS (exit 1) when:
 *   - two routes collide on one operationId (duplicate operationIds);
 *   - an enrichment targets a route that does not exist (missing/invalid route);
 *   - an enrichment body/response is not a valid TypeBox schema (invalid schema);
 *   - --check and the committed openapi.json differs from a fresh generation (drift).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Kind, type TSchema } from "@sinclair/typebox";
import { type RouteEnrichment, ROUTE_ENRICHMENTS } from "./enrichments";
import { type ScannedRoute, routeKey, scanRoutes } from "./scan-routes";

const REPO_ROOT = process.cwd();
const OUT_FILE = join(REPO_ROOT, "docs/api/openapi.json");

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** TypeBox schema → plain JSON Schema (symbol-keyed metadata is dropped by stringify). */
function toJsonSchema(schema: TSchema): unknown {
  return JSON.parse(JSON.stringify(schema));
}

function isTypeBoxSchema(x: unknown): x is TSchema {
  return typeof x === "object" && x !== null && (Kind as unknown as symbol) in (x as object);
}

const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Stable, unique operationId from method + path. */
function operationId(route: ScannedRoute): string {
  const parts = route.path.split("/").filter(Boolean);
  const tail = parts
    .map((p) =>
      p.startsWith(":")
        ? `By${capitalize(p.slice(1))}`
        : capitalize(p.replace(/[^a-zA-Z0-9]/g, "")),
    )
    .join("");
  return route.method + tail;
}

/** Fastify `:param` → OpenAPI `{param}`. */
const toOpenApiPath = (p: string): string => p.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");

/** OpenAPI path parameters derived from `:param` tokens. */
function pathParameters(path: string): unknown[] {
  const params = [...path.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
  return params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
}

/** OpenAPI query parameters from a TypeBox object schema (each property → one `in: query` param). */
function queryParameters(schema: TSchema | undefined): unknown[] {
  if (!schema) return [];
  const json = toJsonSchema(schema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: propSchema,
  }));
}

/** OpenAPI header parameters from an enrichment's `headers` map (e.g. `Idempotency-Key`, `If-Match`). */
function headerParameters(
  headers: RouteEnrichment["headers"] | undefined,
): unknown[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, spec]) => ({
    name,
    in: "header",
    required: spec.required ?? false,
    ...(spec.description ? { description: spec.description } : {}),
    schema: { type: "string" },
  }));
}

interface BuildResult {
  doc: Record<string, unknown>;
  errors: string[];
}

function build(routes: ScannedRoute[]): BuildResult {
  const errors: string[] = [];

  // 1. enrichment keys must point at a real route; schemas must be valid TypeBox.
  const routeKeys = new Set(routes.map(routeKey));
  for (const [key, enrich] of Object.entries(ROUTE_ENRICHMENTS)) {
    if (!routeKeys.has(key)) errors.push(`enrichment targets unknown route: "${key}"`);
    if (enrich.body !== undefined && !isTypeBoxSchema(enrich.body))
      errors.push(`enrichment "${key}": body is not a TypeBox schema`);
    if (enrich.query !== undefined && !isTypeBoxSchema(enrich.query))
      errors.push(`enrichment "${key}": query is not a TypeBox schema`);
    if (enrich.response !== undefined && !isTypeBoxSchema(enrich.response))
      errors.push(`enrichment "${key}": response is not a TypeBox schema`);
  }

  // 2. assemble paths; detect duplicate operationIds.
  const paths: Record<string, Record<string, unknown>> = {};
  const opIds = new Map<string, string>();
  for (const route of routes) {
    const opId = operationId(route);
    const existing = opIds.get(opId);
    if (existing)
      errors.push(`duplicate operationId "${opId}" for "${routeKey(route)}" and "${existing}"`);
    opIds.set(opId, routeKey(route));

    const enrich = ROUTE_ENRICHMENTS[routeKey(route)];
    const successStatus = String(enrich?.status ?? 200);
    const op: Record<string, unknown> = {
      operationId: opId,
      tags: [route.module],
      ...(enrich?.summary ? { summary: enrich.summary } : {}),
      parameters: [
        ...pathParameters(route.path),
        ...queryParameters(enrich?.query),
        ...headerParameters(enrich?.headers),
      ],
      responses: {
        [successStatus]: enrich?.response
          ? {
              description: "OK",
              content: { "application/json": { schema: toJsonSchema(enrich.response) } },
            }
          : { description: "OK" },
        "4XX": { $ref: "#/components/responses/Error" },
        "5XX": { $ref: "#/components/responses/Error" },
      },
    };
    if (enrich?.body) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: toJsonSchema(enrich.body) } },
      };
    }
    const oaPath = toOpenApiPath(route.path);
    paths[oaPath] ??= {};
    paths[oaPath][route.method] = op;
  }

  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: "WardenX API",
      version: readVersion(),
      description:
        "Generated from backend routes + TypeBox enrichments (ADR-0032). Source of truth for the typed frontend client until routes are wired to Fastify schema.",
    },
    paths,
    components: {
      responses: {
        Error: {
          description: "WardenX error envelope",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["error"],
                properties: {
                  error: {
                    type: "object",
                    required: ["code", "message"],
                    properties: {
                      code: { type: "string" },
                      message: { type: "string" },
                      correlationId: { type: "string" },
                      details: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return { doc, errors };
}

function main(): void {
  const check = process.argv.includes("--check");
  const routes = scanRoutes(REPO_ROOT);
  const { doc, errors } = build(routes);

  if (errors.length) {
    console.error("✗ OpenAPI generation failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const json = `${JSON.stringify(doc, null, 2)}\n`;

  if (check) {
    if (!existsSync(OUT_FILE)) {
      console.error(`✗ ${OUT_FILE} is missing. Run: bun run openapi:emit`);
      process.exit(1);
    }
    const current = readFileSync(OUT_FILE, "utf8");
    if (current !== json) {
      console.error("✗ docs/api/openapi.json is out of date. Run: bun run openapi:emit");
      process.exit(1);
    }
    console.log(
      `✓ openapi.json up to date (${routes.length} routes, ${Object.keys(ROUTE_ENRICHMENTS).length} enriched)`,
    );
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, json);
  console.log(
    `✓ wrote docs/api/openapi.json (${routes.length} routes, ${Object.keys(ROUTE_ENRICHMENTS).length} enriched)`,
  );
}

main();
