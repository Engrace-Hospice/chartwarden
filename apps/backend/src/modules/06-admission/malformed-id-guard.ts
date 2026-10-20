// apps/backend/src/modules/06-admission/malformed-id-guard.ts — a non-uuid `:id` (`/admissions/undefined`)
// must answer the standard 404, not the 500 Postgres' uuid cast produces.
//
// Slice/in-memory ids are deliberately non-uuid (`adm_1`), so the route layer cannot demand a uuid; the
// production DB service and ABAC resolver can. They are wrapped ONCE at wiring (index.ts) rather than
// patched per route: any method whose query dies on the uuid cast reports "not found", exactly as an
// unknown uuid does (404-on-deny — no oracle for existence). Workers call the unwrapped factories, so
// a genuine 22P02 there still fails loudly.
import { ResourceNotFoundError } from "./routes/service";

const MAX_CAUSE_DEPTH = 5;

/** pg raises 22P02 from `string_to_uuid` for a malformed uuid literal; other 22P02s are not ours. */
export function isUuidCastError(err: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || !(err instanceof Error)) return false;
  const e = err as { code?: unknown; routine?: unknown; cause?: unknown };
  if (e.code === "22P02" && e.routine === "string_to_uuid") return true;
  return isUuidCastError(e.cause, depth + 1);
}

/** Warn sink (default `console.warn`, the bootstrap convention): injectable so the test can assert on it. */
export type MalformedIdWarn = (message: string) => void;

/** Pull the pg code/routine off the error or its cause chain; never the SQL text or bound params. */
function pgDiagnostics(err: unknown, depth = 0): { code?: string; routine?: string } {
  if (depth > MAX_CAUSE_DEPTH || !(err instanceof Error)) return {};
  const e = err as { code?: unknown; routine?: unknown; cause?: unknown };
  if (typeof e.code === "string") {
    return { code: e.code, ...(typeof e.routine === "string" ? { routine: e.routine } : {}) };
  }
  return pgDiagnostics(e.cause, depth + 1);
}

function asNotFound(err: unknown, method: string, warn: MalformedIdWarn): unknown {
  if (!isUuidCastError(err)) return err;
  // The 404 hides the cause from the client; keep it visible server-side (no ids, params or SQL).
  const { code, routine } = pgDiagnostics(err);
  warn(
    `malformed id mapped to 404: method=${method} code=${code ?? "?"} routine=${routine ?? "?"}`,
  );
  return new ResourceNotFoundError("resource");
}

export function mapMalformedIdTo404<T extends object>(
  target: T,
  warn: MalformedIdWarn = (m) => console.warn(m),
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const member = Reflect.get(obj, prop, receiver);
      if (typeof member !== "function") return member;
      const method = String(prop);
      return (...args: unknown[]) => {
        try {
          const out = member.apply(obj, args);
          return out instanceof Promise
            ? out.catch((e: unknown) => Promise.reject(asNotFound(e, method, warn)))
            : out;
        } catch (e) {
          throw asNotFound(e, method, warn);
        }
      };
    },
  });
}
