/**
 * The two string grammars a database client hands to libpq or to a URL parser (wave 10, B1-B3; round-7 R7-CR-3, R7-CR-4,
 * R7-CR-5, R7-ADV-1, R7-ADV-2). Pure; `db-target.ts` decides what the pieces mean.
 *
 * A libpq URI (`conninfo_uri_parse`): the scheme, `//`, the userinfo up to the first `@` that comes before the first `/`,
 * the host list (a host ends at `:`, `/`, `?` or `,`), a port, `/dbname`, then `?` and the query parameters. `#` is NOT
 * special, so `postgres://localhost/db#?host=H` connects to H and `postgres://localhost?@H/db` connects to H (verified
 * with libpq 16: `pg_isready -d` against 127.0.0.1 on a closed port). Other clients parse a URL differently (a WHATWG URL
 * ends the authority at `?` or `#`; MongoDB's spec takes the userinfo to the LAST `@`), so the readings are listed and the
 * caller takes the hosts of every one: an unknown reading is not an allow.
 *
 * A libpq connection string (`conninfo_parse`): `key = value` pairs; a value is quoted with `'` or ends at a space, and a
 * backslash escapes the next character in BOTH forms. A word with no `=` makes libpq refuse the string.
 */

/** What one reading of a URI makes of it: the host list as written, and the text after the first `?`. */
export interface UriReading {
  readonly hostSection: string;
  readonly query: string;
}

const queryOf = (text: string): string => {
  const at = text.indexOf("?");
  return at < 0 ? "" : text.slice(at + 1);
};

/** The reading that puts the userinfo before the `@` at `at` of `head` (`head` is the text before the first `/`). */
function afterUserinfo(rest: string, head: string, at: number): UriReading {
  const after = at < 0 ? rest : rest.slice(at + 1);
  const hostEnd = after.search(/[/?]/);
  return { hostSection: hostEnd < 0 ? after : after.slice(0, hostEnd), query: queryOf(after) };
}

/** The readings (at most three) of the text after `scheme://`; the caller reads the hosts and the query of each. */
export function uriReadings(rest: string): readonly UriReading[] {
  const slash = rest.indexOf("/");
  const head = slash < 0 ? rest : rest.slice(0, slash);
  const readings: UriReading[] = [
    // libpq: userinfo ends at the FIRST `@` before the first `/`; `?` and `#` do not end the authority.
    afterUserinfo(rest, head, head.indexOf("@")),
    // A client that takes the userinfo to the LAST `@` (the MongoDB spec, Redis, MySQL shell URIs).
    afterUserinfo(rest, head, head.lastIndexOf("@")),
  ];
  // A WHATWG URL: the authority ends at `/`, `?` or `#`, and a `#` ends the query.
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd < 0 ? "" : rest.slice(authorityEnd);
  readings.push({
    hostSection: authority.slice(authority.lastIndexOf("@") + 1),
    query: queryOf(tail.split("#")[0] ?? ""),
  });
  const distinct = new Map(readings.map((r) => [`${r.hostSection}\u0000${r.query}`, r]));
  return [...distinct.values()];
}

export interface Conninfo {
  /** The `key`, `value` pairs libpq stores, in order (a later `host=` replaces an earlier one; the caller reads all). */
  readonly pairs: ReadonlyArray<readonly [string, string]>;
  /** libpq refuses the string: a word with no `=`, or an open quote. No connection is made, but the guard denies. */
  readonly error?: "missing-equals" | "open-quote";
}

/** `conninfo_parse` of libpq (fe-connect.c), character for character. */
export function parseConninfo(text: string): Conninfo {
  const pairs: Array<readonly [string, string]> = [];
  const n = text.length;
  const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
  let i = 0;
  while (i < n) {
    if (isSpace(text[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && text[i] !== "=" && !isSpace(text[i])) i++;
    const key = text.slice(start, i).toLowerCase();
    while (i < n && isSpace(text[i])) i++;
    if (text[i] !== "=") return { pairs, error: "missing-equals" };
    i++;
    while (i < n && isSpace(text[i])) i++;
    let value = "";
    if (text[i] !== "'") {
      while (i < n && !isSpace(text[i])) {
        if (text[i] === "\\") i++;
        if (i < n) value += text[i];
        i++;
      }
    } else {
      i++;
      for (;;) {
        if (i >= n) return { pairs, error: "open-quote" };
        if (text[i] === "\\") {
          i++;
          if (i < n) value += text[i];
          i++;
        } else if (text[i] === "'") {
          i++;
          break;
        } else value += text[i++];
      }
    }
    pairs.push([key, value]);
  }
  return { pairs };
}
