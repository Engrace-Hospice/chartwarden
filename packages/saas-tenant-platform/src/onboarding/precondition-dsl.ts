// @wardenx/saas-tenant-platform · onboarding — the typed precondition-DSL evaluator (M34 §2.3 / D3).
//
// The `precondition_dsl` column on `onboarding_task_template` (§3.4) holds a SMALL, NON-Turing-complete
// boolean expression evaluated against the structured {@link OnboardingContext} at advance-attempt time.
// The §3.12 seed exercises exactly this grammar:
//   org_seeded                 context.providerEntityCount > 0 AND context.locationCount > 0
//   ccn_registered             context.providerEntities[*].ccn != null
//   mac_configured             context.macFeedConfigured == true
//   go_live_checklist_complete context.allCanonicalTasksDoneOrSkipped == true AND context.baaExecuted == true
//
// The whole point (D3): adding/altering a step is a SEED change, not a code change — so the evaluator
// is data-driven over the expression string, with NO per-step code branch. It is also pure (no IO, no
// clock, no RNG): the same context + expression always yields the same verdict, so it is unit-testable
// with a hand-built context and the worker's blocker decisions are deterministic.
//
// Grammar (recursive-descent, precedence OR < AND < comparison):
//   expr        := orExpr
//   orExpr      := andExpr ( 'OR' andExpr )*
//   andExpr     := cmpExpr ( 'AND' cmpExpr )*
//   cmpExpr     := operand ( ('=='|'!='|'>'|'>='|'<'|'<=') operand )?   // bare operand must be boolean
//   operand     := path | literal | '(' expr ')'
//   path        := 'context' ( '.' ident | '[*]' '.' ident )+           // [*] = "for every element"
//   literal     := number | 'true' | 'false' | 'null' | "'" string "'"
//
// The `[*]` quantifier means "for EVERY element of the preceding array, the trailing predicate holds"
// (universal). `context.providerEntities[*].ccn != null` ⇒ every provider entity has a non-null CCN.
// An empty array makes a `[*]` predicate vacuously TRUE — so the worker pairs it with a separate
// non-empty fact (e.g. `providerEntityCount > 0`) where emptiness must block, exactly as the seed does.
import type {
  OnboardingContext,
  OnboardingContextValue,
  OnboardingProviderEntityView,
} from "./context";

/** A precondition-DSL parse/evaluation failure — a malformed expression in a seed row. Surfaced so a
 *  bad `onboarding_task_template.precondition_dsl` fails LOUD at advance time, never silently passes. */
export class PreconditionDslError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(`precondition DSL error in "${expression}": ${message}`);
    this.name = "PreconditionDslError";
  }
}

// ── tokenizer ─────────────────────────────────────────────────────────────────────────────────────

type TokenKind =
  | "path"
  | "number"
  | "string"
  | "bool"
  | "null"
  | "op"
  | "and"
  | "or"
  | "lparen"
  | "rparen";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const COMPARATORS = new Set(["==", "!=", ">=", "<=", ">", "<"]);

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const c = expression[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen", value: "(" });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen", value: ")" });
      i += 1;
      continue;
    }
    // two-char then one-char comparators
    const two = expression.slice(i, i + 2);
    if (COMPARATORS.has(two)) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if (two[0] !== undefined && COMPARATORS.has(two[0]) && (two[0] === ">" || two[0] === "<")) {
      tokens.push({ kind: "op", value: two[0] });
      i += 1;
      continue;
    }
    // single-quoted string literal
    if (c === "'") {
      let j = i + 1;
      while (j < n && expression[j] !== "'") j += 1;
      if (j >= n) throw new PreconditionDslError("unterminated string literal", expression);
      tokens.push({ kind: "string", value: expression.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    // number literal
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && (expression[j] as string) >= "0" && (expression[j] as string) <= "9") j += 1;
      if (expression[j] === ".") {
        j += 1;
        while (j < n && (expression[j] as string) >= "0" && (expression[j] as string) <= "9")
          j += 1;
      }
      tokens.push({ kind: "number", value: expression.slice(i, j) });
      i = j;
      continue;
    }
    // identifier / keyword / path (allows letters, digits, '_', '.', '[', '*', ']')
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.[\]*]/.test(expression[j] as string)) j += 1;
      const word = expression.slice(i, j);
      i = j;
      if (word === "AND") tokens.push({ kind: "and", value: word });
      else if (word === "OR") tokens.push({ kind: "or", value: word });
      else if (word === "true" || word === "false") tokens.push({ kind: "bool", value: word });
      else if (word === "null") tokens.push({ kind: "null", value: word });
      else tokens.push({ kind: "path", value: word });
      continue;
    }
    throw new PreconditionDslError(`unexpected character '${c}' at position ${i}`, expression);
  }
  return tokens;
}

// ── path resolution ─────────────────────────────────────────────────────────────────────────────────

type ResolvedOperand =
  | { readonly kind: "scalar"; readonly value: string | number | boolean | null }
  /** A `[*]`-quantified path: the trailing field projected over every array element. The comparison
   *  applies universally — TRUE iff the predicate holds for EVERY element (vacuously true if empty). */
  | {
      readonly kind: "quantified";
      readonly values: ReadonlyArray<string | number | boolean | null>;
    };

const CONTEXT_SCALARS: ReadonlySet<string> = new Set([
  "providerEntityCount",
  "locationCount",
  "macFeedConfigured",
  "dosespotKickoffRecorded",
  "xeroConnected",
  "gustoConnected",
  "primaryLocationExists",
  "orgAdminAcceptedMembershipCount",
  "allCanonicalTasksDoneOrSkipped",
  "baaExecuted",
]);

/** Project a single provider-entity field the `[*]` quantifier supports. Only `ccn` is referenced by
 *  the §3.12 seed; new fields are added here AND on {@link OnboardingProviderEntityView} together. */
function projectProviderEntityField(
  entity: OnboardingProviderEntityView,
  field: string,
  expression: string,
): string | number | boolean | null {
  if (field === "ccn") return entity.ccn;
  if (field === "providerEntityId") return entity.providerEntityId;
  throw new PreconditionDslError(
    `unknown provider-entity field 'providerEntities[*].${field}'`,
    expression,
  );
}

function resolvePath(path: string, ctx: OnboardingContext, expression: string): ResolvedOperand {
  if (!path.startsWith("context.")) {
    throw new PreconditionDslError(`path must start with 'context.': '${path}'`, expression);
  }
  const rest = path.slice("context.".length);

  // Quantified array path: providerEntities[*].<field>
  const starMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\[\*\]\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (starMatch) {
    const [, arrayName, field] = starMatch as unknown as [string, string, string];
    if (arrayName !== "providerEntities") {
      throw new PreconditionDslError(
        `unknown quantified array 'context.${arrayName}[*]'`,
        expression,
      );
    }
    const values = ctx.providerEntities.map((e) =>
      projectProviderEntityField(e, field, expression),
    );
    return { kind: "quantified", values };
  }

  if (rest.includes("[") || rest.includes("*") || rest.includes(".")) {
    throw new PreconditionDslError(`unsupported path shape 'context.${rest}'`, expression);
  }
  if (!CONTEXT_SCALARS.has(rest)) {
    throw new PreconditionDslError(`unknown context field 'context.${rest}'`, expression);
  }
  const raw = (ctx as unknown as Record<string, OnboardingContextValue>)[rest];
  // All scalar context fields are string | number | boolean | null at this point.
  return { kind: "scalar", value: raw as string | number | boolean | null };
}

// ── recursive-descent parser + evaluator (parse and evaluate in one pass; the grammar is tiny) ───────

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly ctx: OnboardingContext,
    private readonly expression: string,
  ) {}

  evaluate(): boolean {
    const value = this.parseOr();
    if (this.pos !== this.tokens.length) {
      throw new PreconditionDslError(
        `unexpected trailing token '${this.peek()?.value}'`,
        this.expression,
      );
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined)
      throw new PreconditionDslError("unexpected end of expression", this.expression);
    this.pos += 1;
    return t;
  }

  private parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek()?.kind === "or") {
      this.next();
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  private parseAnd(): boolean {
    let left = this.parseComparison();
    while (this.peek()?.kind === "and") {
      this.next();
      const right = this.parseComparison();
      left = left && right;
    }
    return left;
  }

  private parseComparison(): boolean {
    // A parenthesised boolean sub-expression.
    if (this.peek()?.kind === "lparen") {
      this.next();
      const inner = this.parseOr();
      if (this.peek()?.kind !== "rparen") {
        throw new PreconditionDslError("missing closing ')'", this.expression);
      }
      this.next();
      return inner;
    }
    const left = this.parseOperand();
    const op = this.peek();
    if (op?.kind === "op") {
      this.next();
      const right = this.parseOperand();
      return this.applyComparison(left, op.value, right);
    }
    // No comparator → the operand must itself be boolean (e.g. a bare boolean context field, though the
    // seed always writes `== true`; this keeps `context.someBool` legal).
    return this.coerceBoolean(left);
  }

  private parseOperand(): ResolvedOperand {
    const t = this.next();
    switch (t.kind) {
      case "path":
        return resolvePath(t.value, this.ctx, this.expression);
      case "number":
        return { kind: "scalar", value: Number(t.value) };
      case "bool":
        return { kind: "scalar", value: t.value === "true" };
      case "null":
        return { kind: "scalar", value: null };
      case "string":
        return { kind: "scalar", value: t.value };
      default:
        throw new PreconditionDslError(`expected an operand, got '${t.value}'`, this.expression);
    }
  }

  private coerceBoolean(operand: ResolvedOperand): boolean {
    if (operand.kind !== "scalar" || typeof operand.value !== "boolean") {
      throw new PreconditionDslError(
        "a bare operand without a comparator must be boolean",
        this.expression,
      );
    }
    return operand.value;
  }

  private applyComparison(left: ResolvedOperand, op: string, right: ResolvedOperand): boolean {
    // Universal quantifier: a `[*]` operand on either side means "the comparison holds for every element".
    if (left.kind === "quantified" && right.kind === "quantified") {
      throw new PreconditionDslError("cannot compare two quantified paths", this.expression);
    }
    if (left.kind === "quantified") {
      if (right.kind !== "scalar") {
        throw new PreconditionDslError("cannot compare two quantified paths", this.expression);
      }
      const other = right.value;
      return left.values.every((v) => this.compareScalars(v, op, other));
    }
    if (right.kind === "quantified") {
      const other = left.value;
      return right.values.every((v) => this.compareScalars(other, op, v));
    }
    return this.compareScalars(left.value, op, right.value);
  }

  private compareScalars(
    a: string | number | boolean | null,
    op: string,
    b: string | number | boolean | null,
  ): boolean {
    switch (op) {
      case "==":
        return a === b;
      case "!=":
        return a !== b;
      case ">":
      case ">=":
      case "<":
      case "<=": {
        if (typeof a !== "number" || typeof b !== "number") {
          throw new PreconditionDslError(
            `relational operator '${op}' requires numeric operands`,
            this.expression,
          );
        }
        if (op === ">") return a > b;
        if (op === ">=") return a >= b;
        if (op === "<") return a < b;
        return a <= b;
      }
      default:
        throw new PreconditionDslError(`unknown operator '${op}'`, this.expression);
    }
  }
}

/**
 * Evaluate a `precondition_dsl` expression against an {@link OnboardingContext} (§2.3 / D3). Returns the
 * boolean verdict the §2.3 machine uses to decide whether a step's precondition is satisfied. A `null`
 * or empty expression is treated as "no precondition" → always satisfied (the seed's `account_created`,
 * `sample_data_loaded` rows carry `precondition_dsl = NULL`). Throws {@link PreconditionDslError} on a
 * malformed expression so a bad seed fails loud rather than silently advancing.
 */
export function evaluatePrecondition(
  expression: string | null | undefined,
  ctx: OnboardingContext,
): boolean {
  if (expression == null || expression.trim().length === 0) return true;
  const tokens = tokenize(expression);
  return new Parser(tokens, ctx, expression).evaluate();
}
