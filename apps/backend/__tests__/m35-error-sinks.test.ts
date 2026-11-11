/**
 * M35's sweeps and runners catch errors that can be DATABASE errors, and a Drizzle error's message is
 * `Failed query: <sql> params: <the bound values>` (F-027). Two kinds of proof that none of those values reaches a log line or a
 * column:
 *
 *  1. BEHAVIOUR. The real sinks run with a failing collaborator that throws a database-shaped error carrying a marker value, through
 *     the real Pino logger options the host uses; the marker must be in no log line and no value written to the database.
 *  2. STRUCTURE. A syntax-tree scan of every non-test source file of the M35 module and `packages/subscription-billing` finds any
 *     caught error that is turned into text (`.message`, `["message"]`, `String(e)`, a template or `+`, destructuring) or logged
 *     under a key other than `err` (the only key Pino's redacting serializer is registered for). It reads the tree, not the spelling,
 *     so a different way of writing the same leak is caught, and it proves itself against a list of spellings first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pino from "pino";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildLoggerOptions } from "../src/bootstrap/plugins/logger";
import { runM35Fanout } from "../src/modules/35-subscription/billing-runtime/jobs";
import { runRefundExecutionSweep } from "../src/modules/35-subscription/billing-runtime/refund-executor";
import { runWebhookHandlerSweep } from "../src/modules/35-subscription/billing-runtime/webhook-handler";

/** The values a failing statement binds. If any reaches a sink, the sink has leaked. */
const MARKER = "bound-marker-9d2f41";
const SECOND_MARKER = "Nakamura-Yuki-1948";
const BOUND = [MARKER, SECOND_MARKER];
const wrapped = () =>
  new DrizzleQueryError(
    'update "refund" set "stripe_failure_code" = $1 where "id" = $2',
    BOUND,
    Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      severity: "ERROR",
      detail: `Key (id)=(${MARKER}) already exists.`,
    }),
  );

/** The host's logger (the same options index.ts builds), writing to memory, behind the same adapter index.ts passes as `log`. */
function hostLogger() {
  const lines: string[] = [];
  const logger = pino(
    { ...buildLoggerOptions(), level: "trace" },
    { write: (l: string) => void lines.push(l) },
  );
  const log = (message: string, detail: Record<string, unknown>) => logger.warn(detail, message);
  return { lines, log };
}

/** Every string reachable in `value` (cycles and column objects included: a Drizzle `set` carries both). */
function stringsIn(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((v) => stringsIn(v, seen));
}

const leaked = (value: unknown): boolean =>
  stringsIn(value).some((text) => BOUND.some((marker) => text.includes(marker)));

/** A transaction double: `select` answers from a queue, `insert` returns an id, `update` records what it sets and returns a row. */
function recordingRunner(selects: unknown[][]) {
  const queue = [...selects];
  const sets: Record<string, unknown>[] = [];
  const chain = (rows: unknown[]): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop) =>
        prop === "then" ? (resolve: (v: unknown[]) => void) => resolve(rows) : () => proxy,
      apply: () => proxy,
    });
    return proxy;
  };
  const tx = {
    select: () => chain(queue.shift() ?? []),
    insert: () => ({ values: () => chain([{ id: "audit-1" }]) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return chain([{ id: "row-1" }]);
      },
    }),
  };
  const platformRunner = (async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) as never;
  return { platformRunner, sets };
}

describe("behaviour: a database error's bound values reach no log line and no persisted value", () => {
  it("the org fan-out (every M35 sweep, the statement sweep included) logs the error under `err`, through the host's serializer", async () => {
    const { lines, log } = hostLogger();
    await expect(
      runM35Fanout(
        { listOrgs: async () => [{ organizationId: "org-1" }], log },
        async () => {
          throw wrapped();
        },
        "pricing_statement",
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] as string) as { organizationId: string; err: unknown };
    expect(line.organizationId).toBe("org-1");
    expect(line.err).toBeTruthy(); // diagnosable: the redacted error is there
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(lines.join("\n")).not.toContain(SECOND_MARKER);
  });

  it("the Stripe webhook handler: stripe_webhook_event.error_text and its log line carry no bound value", async () => {
    const { lines, log } = hostLogger();
    const { platformRunner, sets } = recordingRunner([
      [{ id: "evt-1", eventType: "invoice.paid", payloadCiphertext: "x" }],
    ]);
    const cipher = {
      decrypt: () => {
        throw wrapped();
      },
    };

    const result = await runWebhookHandlerSweep({
      db: {} as never,
      platformRunner,
      outbox: {} as never,
      listOrgs: async () => [],
      log,
      cipher: cipher as never,
    });

    expect(result.failed).toBe(1);
    const persisted = sets.find((s) => "errorText" in s);
    expect(typeof persisted?.errorText).toBe("string");
    expect(leaked(persisted)).toBe(false);
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(lines.join("\n")).not.toContain(SECOND_MARKER);
  });

  it("the refund executor: a database failure during a Stripe call reaches the audit row, the refund's failure code and the log without its values", async () => {
    const { lines, log } = hostLogger();
    const approved = [
      { id: "refund-1", organizationId: "org-1", amountCents: 500, stripeInvoiceId: "in_1" },
    ];
    // loadApproved, then nextAttemptIndex, then the dispatcher's pre-check (no prior success)
    const { platformRunner, sets } = recordingRunner([approved, [{ last: null }], []]);
    // the 2xx came back and a database write after it failed: the dispatcher's `try` covers both
    const client = {
      execute: async () => {
        throw wrapped();
      },
    };

    const result = await runRefundExecutionSweep({ platformRunner, client: client as never, log });

    expect(result.failed + result.retryLater).toBe(1);
    const auditError = sets.find((s) => "errorText" in s);
    const failureCode = sets.find((s) => "stripeFailureCode" in s);
    expect(auditError).toBeDefined();
    expect(leaked(auditError)).toBe(false);
    if (failureCode) expect(leaked(failureCode)).toBe(false);
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(lines.join("\n")).not.toContain(SECOND_MARKER);
  });
});

// ── structure ────────────────────────────────────────────────────────────────────────────────────────────

const unwrap = (node: ts.Node): ts.Node => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

/**
 * Errors this codebase AUTHORS the message of: reading `.message` off one that was just narrowed with `instanceof` is not a leak (it is
 * how a typed refusal is re-thrown with its own text). `Error` itself is deliberately not here: it is what a database error is.
 */
const AUTHORED_ERRORS = new Set([
  "ChartWardenError",
  "ConflictError",
  "NotFoundError",
  "ValidationError",
  "PaymentMethodRejectedError",
]);

/** True when `node` sits in the branch of an `if`/ternary that narrowed `name` with `instanceof <an authored error>`. */
function narrowedToAuthoredError(node: ts.Node, name: string): boolean {
  for (let current: ts.Node | undefined = node; current?.parent; current = current.parent) {
    const parent: ts.Node = current.parent;
    const branch =
      (ts.isIfStatement(parent) && parent.thenStatement === current) ||
      (ts.isConditionalExpression(parent) && parent.whenTrue === current);
    if (!branch) continue;
    const condition = ts.isIfStatement(parent)
      ? parent.expression
      : (parent as ts.ConditionalExpression).condition;
    const test = unwrap(condition);
    if (
      ts.isBinaryExpression(test) &&
      test.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(unwrap(test.left)) &&
      (unwrap(test.left) as ts.Identifier).text === name &&
      ts.isIdentifier(test.right) &&
      AUTHORED_ERRORS.has(test.right.text)
    ) {
      return true;
    }
  }
  return false;
}

/** Every way a caught error can be turned into text, or logged where the redacting serializer does not look. */
function findErrorLeaks(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const leaks: string[] = [];
  const report = (node: ts.Node, what: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    leaks.push(`${fileName}:${line + 1} ${what}`);
  };

  function inspect(scope: ts.Node, name: string): void {
    const isCaught = (node: ts.Node): boolean => {
      const inner = unwrap(node);
      return ts.isIdentifier(inner) && inner.text === name;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isCaught(node.expression)) {
        if (
          ["message", "stack", "toString"].includes(node.name.text) &&
          !narrowedToAuthoredError(node, name)
        )
          report(node, `.${node.name.text} of the caught error`);
      } else if (ts.isElementAccessExpression(node) && isCaught(node.expression)) {
        report(node, "indexed read of the caught error");
      } else if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const stringifies =
          (ts.isIdentifier(callee) && callee.text === "String") ||
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            ["JSON", "util"].includes(callee.expression.text) &&
            ["stringify", "inspect", "format"].includes(callee.name.text));
        if (stringifies && node.arguments.some(isCaught))
          report(node, "the caught error stringified");
      } else if (ts.isTemplateSpan(node) && isCaught(node.expression)) {
        report(node, "the caught error in a template");
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        (isCaught(node.left) || isCaught(node.right))
      ) {
        report(node, "the caught error concatenated");
      } else if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        isCaught(node.initializer) &&
        !ts.isIdentifier(node.name)
      ) {
        report(node, "the caught error destructured");
      } else if (ts.isPropertyAssignment(node) && isCaught(node.initializer)) {
        const key =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "?";
        if (key !== "err")
          report(
            node,
            `the caught error stored under \`${key}\` (the logger redacts only \`err\`)`,
          );
      } else if (
        ts.isShorthandPropertyAssignment(node) &&
        node.name.text === name &&
        name !== "err"
      ) {
        report(node, `the caught error stored under \`${name}\` (the logger redacts only \`err\`)`);
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
  }

  const walk = (node: ts.Node): void => {
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name)
    ) {
      inspect(node.block, node.variableDeclaration.name.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const handler =
        method === "catch" ? node.arguments[0] : method === "then" ? node.arguments[1] : undefined;
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const param = handler.parameters[0]?.name;
        if (param && ts.isIdentifier(param)) inspect(handler.body, param.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return leaks;
}

describe("structure: the scan finds a caught error turned into text, however it is spelled", () => {
  const leakIn = (body: string) => findErrorLeaks("x.ts", `async function f() { ${body} }`);

  it.each([
    ["err.message", "try { a(); } catch (err) { log({ m: err.message }); }"],
    ["a cast", "try { a(); } catch (e) { log({ m: (e as Error).message }); }"],
    [
      "a ternary",
      "try { a(); } catch (err) { const m = err instanceof Error ? err.message : String(err); }",
    ],
    [
      "a message read after narrowing to plain Error (which is what a database error is)",
      "try { a(); } catch (err) { if (err instanceof Error) log({ m: err.message }); }",
    ],
    ["String()", "try { a(); } catch (e) { log({ m: String(e) }); }"],
    ["an indexed read", 'try { a(); } catch (e) { log({ m: e["message"] }); }'],
    ["a template", "try { a(); } catch (e) { log(`failed: ${e}`); }"],
    ["a concatenation", 'try { a(); } catch (e) { log("failed: " + e); }'],
    ["destructuring", "try { a(); } catch (e) { const { message } = e; }"],
    ["stack", "try { a(); } catch (e) { log({ s: e.stack }); }"],
    ["JSON.stringify", "try { a(); } catch (e) { log({ s: JSON.stringify(e) }); }"],
    ["a promise handler", "a().catch((e) => log({ m: e.message }));"],
    ["a then rejection handler", "a().then(ok, (e) => log({ m: e.message }));"],
    ["a different key", "try { a(); } catch (error) { log({ error }); }"],
    ["a different key, assigned", "try { a(); } catch (e) { log({ cause: e }); }"],
  ])("%s", (_name, body) => {
    expect(leakIn(body).length).toBeGreaterThan(0);
  });

  it.each([
    ["the error under `err`", "try { a(); } catch (err) { log({ id, err }); }"],
    ["assigned to `err`", "try { a(); } catch (error) { log({ id, err: error }); }"],
    ["handed to a redacting helper", "try { a(); } catch (e) { persist(safeErrorMessage(e)); }"],
    ["rethrown", "try { a(); } catch (e) { throw e; }"],
    [
      "a code read off an own error",
      "try { a(); } catch (e) { return e instanceof Err ? e.code : 'x'; }",
    ],
    ["a promise handler that logs it under err", "a().catch((e) => log({ err: e }));"],
    [
      "an error this codebase authors, narrowed first",
      "try { a(); } catch (err) { if (err instanceof PaymentMethodRejectedError) throw new X(err.message); throw err; }",
    ],
  ])("%s is clean", (_name, body) => {
    expect(leakIn(body)).toEqual([]);
  });
});

describe("structure: no M35 or subscription-billing source turns a caught error into text", () => {
  const REPO = join(__dirname, "../../..");
  const ROOTS = ["apps/backend/src/modules/35-subscription", "packages/subscription-billing/src"];
  /** Reasoned exceptions: the text is not a database error's. */
  const ALLOWED: Readonly<Record<string, string>> = {
    "packages/subscription-billing/src/stripe/http-transport.ts":
      "the message of a failed fetch to Stripe becomes a StripeTransportError (a Stripe-bound failure; it carries no database value)",
  };

  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
      return path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")
        ? [path]
        : [];
    });

  const files = ROOTS.flatMap((root) => sources(join(REPO, root)));

  it("scans the M35 module and the billing package (and finds files to scan)", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith("billing-runtime/jobs.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("stripe/dispatcher.ts"))).toBe(true);
  });

  it("no unallowed file has a leak", () => {
    const found = files.flatMap((file) => {
      const path = relative(REPO, file);
      return path in ALLOWED ? [] : findErrorLeaks(path, readFileSync(file, "utf8"));
    });
    expect(found).toEqual([]);
  });

  it("every allowed exception still exists and still needs it (a stale entry is deleted)", () => {
    for (const path of Object.keys(ALLOWED)) {
      expect(findErrorLeaks(path, readFileSync(join(REPO, path), "utf8")).length).toBeGreaterThan(
        0,
      );
    }
  });
});
