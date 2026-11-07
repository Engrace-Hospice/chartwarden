// Account-scoped Claim.MD ERA reader. Does not apply tenant filters or mutate Claim.MD download state.
import { createHash } from "node:crypto";
import { budgetedFetch, type ClaimMdRequestCounter } from "./claimmd-rate-limit";
import { hasList, postForm, rawFiles, str, topAttr, vendorError, type ClaimMdRecord } from "./claimmd-wire";

export type ClaimMdEraUsage = "test" | "production";
export interface ClaimMdEraListItem { readonly eraId: string; readonly digest: string; readonly metadata: ClaimMdRecord }
export interface ClaimMdEraListPage {
  readonly afterEraId: string;
  readonly lastEraId: string;
  readonly page: number;
  readonly items: readonly ClaimMdEraListItem[];
  readonly digest: string;
}
export type ClaimMdEraListRead =
  | { readonly ok: true; readonly page: ClaimMdEraListPage }
  | { readonly ok: false; readonly code: "BAD_CURSOR" | "BAD_PAGE" | "CREDENTIAL" | "TRANSPORT" | "BUSINESS_ERROR" | "BAD_ENVELOPE" | "CURSOR_REGRESSION" | "ID_CONFLICT" };
export type ClaimMdEraFileRead =
  | { readonly ok: true; readonly eraId: string; readonly files: readonly string[]; readonly metadata: ClaimMdRecord; readonly digest: string }
  | { readonly ok: false; readonly code: "CREDENTIAL" | "TRANSPORT" | "BUSINESS_ERROR" | "BAD_ENVELOPE" | "ID_MISMATCH" };
export type ClaimMdEraDetailsRead =
  | { readonly ok: true; readonly eraId: string; readonly details: ClaimMdRecord; readonly digest: string }
  | { readonly ok: false; readonly code: "CREDENTIAL" | "TRANSPORT" | "BUSINESS_ERROR" | "BAD_ENVELOPE" | "ID_MISMATCH" };

const ERA_ID = /^\d{1,64}$/;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const container = (body: ClaimMdRecord): ClaimMdRecord =>
  body.result !== null && typeof body.result === "object" && !Array.isArray(body.result)
    ? body.result as ClaimMdRecord : body;

/** Validates a list response without converting ERA IDs to Number or dropping malformed vendor rows. */
export function captureClaimMdEraListPage(body: ClaimMdRecord, afterEraId: string, page: number): ClaimMdEraListRead {
  if (!ERA_ID.test(afterEraId)) return { ok: false, code: "BAD_CURSOR" };
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) return { ok: false, code: "BAD_PAGE" };
  const root = container(body);
  const rawList = root.era ?? body.era;
  if (rawList === undefined && Object.keys(body).length > 0) return { ok: false, code: "BAD_ENVELOPE" };
  if (!hasList(body, "era")) return { ok: false, code: "BAD_ENVELOPE" };
  const rawRecords = rawList === undefined ? [] : Array.isArray(rawList) ? rawList : [rawList];
  if (rawRecords.some((item) => item === null || typeof item !== "object" || Array.isArray(item)))
    return { ok: false, code: "BAD_ENVELOPE" };
  const records = rawRecords as ClaimMdRecord[];
  const lastEraId = topAttr(body, "last_eraid");
  if (!lastEraId || !ERA_ID.test(lastEraId) || BigInt(lastEraId) < BigInt(afterEraId))
    return { ok: false, code: "CURSOR_REGRESSION" };
  const seen = new Map<string, string>();
  const items: ClaimMdEraListItem[] = [];
  for (const metadata of records) {
    const eraId = str(metadata.eraid);
    if (!eraId || !ERA_ID.test(eraId) || BigInt(eraId) <= BigInt(afterEraId) || BigInt(eraId) > BigInt(lastEraId))
      return { ok: false, code: "BAD_ENVELOPE" };
    const itemDigest = digest(metadata);
    const prior = seen.get(eraId);
    if (prior && prior !== itemDigest) return { ok: false, code: "ID_CONFLICT" };
    if (!prior) {
      seen.set(eraId, itemDigest);
      items.push({ eraId, digest: itemDigest, metadata });
    }
  }
  return { ok: true, page: { afterEraId, lastEraId, page, items, digest: digest(body) } };
}

export interface ClaimMdEraPagePort {
  list(accountReference: string, usage: ClaimMdEraUsage, afterEraId: string, page: number): Promise<ClaimMdEraListRead>;
}
export interface ClaimMdEraDiscoveryCommitPort {
  /** Must atomically upsert every identity and move the cursor, fenced by leaseGeneration. */
  commit(input: { readonly afterEraId: string; readonly nextEraId: string; readonly leaseGeneration: bigint;
    readonly pages: readonly ClaimMdEraListPage[] }): Promise<void>;
}
export type ClaimMdEraDiscoveryResult =
  | { readonly ok: true; readonly discovered: number; readonly cursor: string; readonly pages: number }
  | { readonly ok: false; readonly code: "VENDOR_READ" | "PAGE_LIMIT" | "WATERMARK_CHANGED" | "NO_PROGRESS" };

/**
 * Reads one bounded account snapshot. Cursor movement happens only after every page has been durably persisted.
 * A crash before commit causes a safe rescan from the old cursor; inbox uniqueness makes that replay idempotent.
 * The vendor does not document snapshot isolation across Page requests, so a changed last_eraid blocks advancement.
 */
export async function discoverClaimMdEraSnapshot(input: {
  readonly reader: ClaimMdEraPagePort; readonly commit: ClaimMdEraDiscoveryCommitPort;
  readonly accountReference: string; readonly usage: ClaimMdEraUsage; readonly cursor: string;
  readonly leaseGeneration: bigint; readonly maxPages?: number;
  readonly beforePage?: () => Promise<void>;
}): Promise<ClaimMdEraDiscoveryResult> {
  const pages: ClaimMdEraListPage[] = [];
  const pageLimit = input.maxPages ?? 100;
  let watermark: string | undefined;
  let discovered = 0;
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
    await input.beforePage?.();
    const result = await input.reader.list(input.accountReference, input.usage, input.cursor, pageNumber);
    if (!result.ok) return { ok: false, code: "VENDOR_READ" };
    const page = result.page;
    if (watermark !== undefined && page.lastEraId !== watermark)
      return { ok: false, code: "WATERMARK_CHANGED" };
    watermark = page.lastEraId;
    if (page.items.length === 0 && BigInt(page.lastEraId) > BigInt(input.cursor))
      return { ok: false, code: "NO_PROGRESS" };
    pages.push(page);
    discovered += page.items.length;
    // Claim.MD documents 100-item pages. A short page is the only positive terminal signal.
    if (page.items.length < 100) {
      const ids = pages.flatMap((p) => p.items.map((item) => item.eraId));
      const uniqueIds = new Set(ids);
      if (uniqueIds.size !== ids.length) {
        // Same ERA ID across pages is acceptable only if its immutable metadata digest agrees.
        const seen = new Map<string, string>();
        for (const item of pages.flatMap((p) => p.items)) {
          const prior = seen.get(item.eraId);
          if (prior !== undefined && prior !== item.digest) return { ok: false, code: "VENDOR_READ" };
          seen.set(item.eraId, item.digest);
        }
      }
      const next = watermark ?? input.cursor;
      if (BigInt(next) < BigInt(input.cursor)) return { ok: false, code: "NO_PROGRESS" };
      await input.commit.commit({ afterEraId: input.cursor, nextEraId: next, leaseGeneration: input.leaseGeneration, pages });
      return { ok: true, discovered, cursor: next, pages: pages.length };
    }
  }
  return { ok: false, code: "PAGE_LIMIT" };
}

/**
 * Reader for one shared Claim.MD account. API keys are kept only in this closure, and every operation uses the same
 * injected account-wide request counter as claim/response traffic. `NewOnly=0` is explicit and no NPI/TIN filter is sent.
 */
export function createClaimMdAccountEraReader(input: {
  readonly accounts: Readonly<Record<string, Readonly<Partial<Record<ClaimMdEraUsage, string>>>>>;
  readonly counter: ClaimMdRequestCounter;
  readonly fetch?: typeof fetch;
}) {
  const keyUsage = new Map<string, ClaimMdEraUsage>();
  for (const modes of Object.values(input.accounts))
    for (const [usage, key] of Object.entries(modes)) if (key) keyUsage.set(key, usage as ClaimMdEraUsage);
  const guarded = budgetedFetch(input.fetch ?? fetch, input.counter, (init) => {
    const body = init?.body;
    const key = body instanceof URLSearchParams ? body.get("AccountKey") : null;
    return key ? keyUsage.get(key) : undefined;
  });
  const keyFor = (accountReference: string, usage: ClaimMdEraUsage) => input.accounts[accountReference]?.[usage];
  return {
    async list(accountReference: string, usage: ClaimMdEraUsage, afterEraId: string, page: number): Promise<ClaimMdEraListRead> {
      const key = keyFor(accountReference, usage);
      if (!key) return { ok: false, code: "CREDENTIAL" };
      if (!ERA_ID.test(afterEraId)) return { ok: false, code: "BAD_CURSOR" };
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) return { ok: false, code: "BAD_PAGE" };
      const wire = await postForm(guarded, "eralist", key, { ERAID: afterEraId, Page: String(page), NewOnly: "0" });
      if (!wire.ok) return { ok: false, code: "TRANSPORT" };
      if (vendorError(wire.body)) return { ok: false, code: "BUSINESS_ERROR" };
      return captureClaimMdEraListPage(wire.body, afterEraId, page);
    },
    async download835(accountReference: string, usage: ClaimMdEraUsage, eraId: string): Promise<ClaimMdEraFileRead> {
      const key = keyFor(accountReference, usage);
      if (!key) return { ok: false, code: "CREDENTIAL" };
      if (!ERA_ID.test(eraId)) return { ok: false, code: "BAD_ENVELOPE" };
      const wire = await postForm(guarded, "era835", key, { eraid: eraId });
      if (!wire.ok) return { ok: false, code: "TRANSPORT" };
      if (vendorError(wire.body)) return { ok: false, code: "BUSINESS_ERROR" };
      const returnedId = topAttr(wire.body, "eraid");
      if (!returnedId) return { ok: false, code: "BAD_ENVELOPE" };
      if (returnedId !== eraId) return { ok: false, code: "ID_MISMATCH" };
      const raw = rawFiles(wire.body, "data");
      if (!raw.ok) return { ok: false, code: "BAD_ENVELOPE" };
      return { ok: true, eraId, files: raw.files, metadata: container(wire.body), digest: digest(raw.files) };
    },
    async details(accountReference: string, usage: ClaimMdEraUsage, eraId: string): Promise<ClaimMdEraDetailsRead> {
      const key = keyFor(accountReference, usage);
      if (!key) return { ok: false, code: "CREDENTIAL" };
      if (!ERA_ID.test(eraId)) return { ok: false, code: "BAD_ENVELOPE" };
      const wire = await postForm(guarded, "eradata", key, { eraid: eraId });
      if (!wire.ok) return { ok: false, code: "TRANSPORT" };
      if (vendorError(wire.body)) return { ok: false, code: "BUSINESS_ERROR" };
      const returnedId = topAttr(wire.body, "eraid");
      if (!returnedId) return { ok: false, code: "BAD_ENVELOPE" };
      if (returnedId !== eraId) return { ok: false, code: "ID_MISMATCH" };
      const details = container(wire.body);
      return { ok: true, eraId, details, digest: digest(details) };
    },
  };
}
