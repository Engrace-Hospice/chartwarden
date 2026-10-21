// @chartwarden/reporting · drilldown — the drilldown URL-template resolver (M33 §5.1.3 / W-R-05 / D16).
//
// Step 1 of the drilldown emit: turn a base's `report_base_catalog.drilldown_url_template` plus the tile's
// dimension context into a candidate navigation URL pointing at the owner module's surface (e.g. M8's late-entry
// register). The template carries `{placeholder}` tokens; each token is substituted ONLY from the catalog-known
// dimension whitelist — a token that is not a whitelisted dimension throws (so a poisoned template can never
// inject an arbitrary key), and a whitelisted token with no value in the context throws (no half-built URL).
// Every substituted value is `encodeURIComponent`-escaped (no query-string injection from a dimension value).
//
// This step does NO consent work — it builds the candidate URL the owner module would receive; `consent-
// narrowing.ts` then narrows it for redaction, and `audit-writer.ts` records the navigation. The owner module
// RE-VALIDATES everything at its own ingress (M33 does not vouch, D16).
//
// PURE: a total function over its inputs (no clock/RNG/Drizzle/`getSeam`/cross-module import).

/** The tile's resolved dimension context (dimension key → its string value), e.g. `{ membershipId, dateRange }`. */
export type DrilldownDimensionContext = Readonly<Record<string, string>>;

/** Raised when a template references an unknown dimension or a whitelisted dimension with no value. */
export class DrilldownTemplateError extends Error {
  constructor(
    public readonly code: "NO_TEMPLATE" | "TEMPLATE_UNKNOWN_DIMENSION" | "TEMPLATE_MISSING_VALUE",
    message: string,
  ) {
    super(message);
    this.name = "DrilldownTemplateError";
  }
}

/** The resolved candidate URL + the dimension keys that were substituted into it. */
export interface ResolvedDrilldownUrl {
  readonly targetUrl: string;
  readonly substitutedKeys: readonly string[];
}

/** Matches `{dimension_key}` tokens (a leading letter/underscore, then word chars — the SQL-ident shape). */
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve a drilldown URL template against a dimension context (PURE, W-R-05 step 4). Substitutes each
 * `{key}` token with `encodeURIComponent(context[key])`. Every token MUST be a member of
 * `allowedDimensionKeys` (the base catalog's dimension whitelist) — an unknown token is a template-injection
 * attempt and throws. A whitelisted token absent from `context` throws rather than emit a half-built URL.
 *
 * @throws {DrilldownTemplateError} `NO_TEMPLATE` (null template) / `TEMPLATE_UNKNOWN_DIMENSION` /
 *                                  `TEMPLATE_MISSING_VALUE`
 */
export function resolveDrilldownUrl(input: {
  readonly template: string | null;
  readonly dimensionContext: DrilldownDimensionContext;
  readonly allowedDimensionKeys: ReadonlySet<string>;
}): ResolvedDrilldownUrl {
  if (input.template === null || input.template.length === 0) {
    throw new DrilldownTemplateError(
      "NO_TEMPLATE",
      "base has no drilldown_url_template — drilldown unsupported",
    );
  }

  const substitutedKeys: string[] = [];
  const targetUrl = input.template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    if (!input.allowedDimensionKeys.has(key)) {
      throw new DrilldownTemplateError(
        "TEMPLATE_UNKNOWN_DIMENSION",
        `drilldown template references "${key}", which is not a whitelisted dimension of this base`,
      );
    }
    const value = input.dimensionContext[key];
    if (value === undefined) {
      throw new DrilldownTemplateError(
        "TEMPLATE_MISSING_VALUE",
        `drilldown template needs dimension "${key}" but the tile context supplied no value`,
      );
    }
    substitutedKeys.push(key);
    return encodeURIComponent(value);
  });

  return { targetUrl, substitutedKeys };
}

/**
 * Append query parameters to a URL, choosing `?` or `&` by whether the URL already has a query string (PURE).
 * Each key/value is `encodeURIComponent`-escaped. Shared by `consent-narrowing.ts` to append the
 * `consentNarrowed`/`excludePatientIds` params. Params with an empty value are skipped.
 */
export function appendQueryParams(url: string, params: Readonly<Record<string, string>>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value.length === 0) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (pairs.length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${pairs.join("&")}`;
}
