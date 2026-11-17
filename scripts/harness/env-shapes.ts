/**
 * Script text that prints the environment or a secret variable (wave 8, T5; round-6 ADV6-8): `print(os.environ)`,
 * `print(*os.environ.items())`, `print(dict(os.environ))`, `json.dumps(dict(os.environ))`, `for k, v in os.environ.items()`,
 * `console.log(process.env)`, `console.log(Bun.env)`, `JSON.stringify({...process.env})`, `Object.entries(process.env)`,
 * `Deno.env.toObject()`, perl `say for %ENV`, ruby `puts ENV.to_h`, awk `for (k in ENVIRON)`, jq `env` and `$ENV`; and a secret
 * variable by name through any of those accessors (`os.environ["X_TOKEN"]`, `Bun.env.X_TOKEN`, `Deno.env.get("X_KEY")`,
 * `$ENV{X_SECRET}`, `ENVIRON["X"]`, `ENV.fetch`). A script that only PASSES the environment on (`connect(process.env)`,
 * `spawn(cmd, {env: process.env})`) is not a dump: a sink (a print, a log, a serializer) has to take it, directly or
 * through up to three wrapping calls, a spread or a splat. Read as text; a name a script builds is unseen. Pure.
 */

/** The upper-case names that hold a secret. */
export const SECRET_WORDS = String.raw`[A-Za-z0-9_]*(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY)`;

/**
 * The repo's own key-encryption and administrative variables (the names of the `.env.example` files): a key-encryption key
 * (`M34_TENANT_KEK`, `M35_PSEUDONYM_KEY_KEK`, their `_RETIRED` twins), the admin, platform and destruction database URLs, the Redis
 * URL and an alert webhook URL (they carry a password or a token), a key ring, the sealed DoseSpot tenant configs, an APNs key and a service-account JSON.
 * Printing one is an ask, not a deny (wave 10, B9; round-7 R7-ADV-14): the documented seed workflow passes M34_TENANT_KEK from
 * the api container, so a human approves a deliberate one. The names `SECRET_WORDS` matches before keep their deny.
 */
export const GUARDED_WORDS = String.raw`[A-Za-z0-9_]*(?:_KEK(?:_RETIRED)?|DATABASE_(?:ADMIN|PLATFORM|DESTRUCTION)_URL|REDIS_URL|WEBHOOK_URL|KEYRING|TENANT_CONFIGS|KEY_P8|SERVICE_ACCOUNT_JSON)`;

/** What prints or serializes its argument, with the open parenthesis (or the space of a `puts X`). */
const SINK = String.raw`\b(?:print|pprint|repr|str|json\.dumps?|console\.(?:log|info|warn|error|dir|table)|JSON\.stringify|Object\.(?:keys|values|entries|fromEntries)|puts|pp|p|say|echo|write)\b\s*\(?\s*`;
/** Up to three calls that wrap the value on its way to the sink (`dict(`, `JSON.stringify(`, `list(`), a spread and an object brace. */
const WRAPPERS = String.raw`(?:[A-Za-z_][\w.]*\s*\(\s*){0,3}(?:\{\s*)?(?:\.\.\.\s*|\*\*?\s*)?`;
/** The whole environment of each language: not one variable of it (`os.environ["X"]`, `process.env.X`). */
const WHOLE_ENVIRONMENT = String.raw`(?:os\.environb?(?!\s*\[|\.(?:get|setdefault|pop|update|__getitem__)\b)|(?:process|Bun)\.env(?![\w.\[])|Deno\.env\.toObject\(\s*\)|Deno\.env(?![\w.\[]))`;

const DUMPS: readonly RegExp[] = [
  new RegExp(`${SINK}${WRAPPERS}${WHOLE_ENVIRONMENT}`),
  // python: a loop over the environment
  /\bfor\s+\w+(?:\s*,\s*\w+)?\s+in\s+(?:sorted\(\s*)?os\.environ\b(?!\s*\[)/,
  // perl: `print %ENV`, `say for %ENV`, `keys %ENV`, `map … %ENV`
  /\b(?:print|say|printf|map|for|foreach|keys|values|each|join)\b[^;\n]{0,80}%ENV\b/,
  // ruby: `puts ENV`, `p ENV.to_h`, `ENV.each`
  /\b(?:puts|p|pp|print)\s+ENV(?:\.(?:to_h|to_a|inspect|to_s|each\w*|map|select|reject))?(?![\w\[.])|\bENV\.(?:to_h|to_a|inspect|each\w*)\b/,
  // awk: a loop over ENVIRON
  /\bfor\s*\(\s*\w+\s+in\s+ENVIRON\s*\)/,
];

const ACCESSORS = String.raw`(?:os\.environ(?:\.get)?\s*[\[(]\s*['"]|os\.getenv\s*\(\s*['"]|(?:process|Bun)\.env\.|(?:process|Bun)\.env\[\s*['"]|Deno\.env\.get\(\s*['"]|ENV\[\s*['"]|ENV\.fetch\(\s*['"]|\$ENV\{\s*['"]?|ENVIRON\s*\[\s*['"])`;
const SECRET_LOOKUP = new RegExp(`${SINK}${WRAPPERS}${ACCESSORS}${SECRET_WORDS}`);
const GUARDED_LOOKUP = new RegExp(`${SINK}${WRAPPERS}${ACCESSORS}${GUARDED_WORDS}(?![A-Za-z0-9_])`);

/** jq reads the environment as `env` (a function) and `$ENV` (a variable). */
const JQ_WHOLE_ENVIRONMENT = /(?:^|[\s(|,\[{])\$?ENV(?![\w.\[])|(?:^|[\s(|,\[{])env(?![\w.\[])/;
const JQ_SECRET = new RegExp(
  String.raw`(?:^|[\s(|,\[{])(?:env|\$ENV)(?:\.|\s*\[\s*")${SECRET_WORDS}`,
);

/**
 * What script text prints from the environment: all of it (`dump`), a secret by name (`secret`: both deny), one of the repo's
 * guarded variables by name (`guarded`: ask); null for none. `jq` reads a jq program.
 */
export function environmentLeak(
  text: string,
  language?: "jq",
): "dump" | "secret" | "guarded" | null {
  if (language === "jq") {
    if (JQ_SECRET.test(text)) return "secret";
    return JQ_WHOLE_ENVIRONMENT.test(text) ? "dump" : null;
  }
  if (DUMPS.some((re) => re.test(text))) return "dump";
  if (SECRET_LOOKUP.test(text)) return "secret";
  return GUARDED_LOOKUP.test(text) ? "guarded" : null;
}
