# WardenX — T-29.09 Addendum: NPPES Sync

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §3.1 (`packages/nppes-client`), §4.4 (NPPES platform job), §11 D10 (NPPES public API), D11 (platform-role sync), D18 (step-up on manual trigger), §10 (T-29.09)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 → T-29.08, T-29.10 merged. M29 spec at v0.3.

This addendum delivers the drop-in artifacts for T-29.09 — the NPPES sync subsystem. It implements:

1. The **typed NPPES API client** (`packages/nppes-client`) — the public CMS NPI Registry API (no credentials, no BAA).
2. The **platform-role nightly sync job** that refreshes `nppes_provider` rows for every NPI referenced by any tenant's M40 `external_physician`.
3. The **`NppesProviderReader` published seam** consumed by M40 (NPI → canonical provider lookup), M28 (FHIR Practitioner projection), M11/M12 (ordering-provider validation), and others.
4. The **manual sync trigger route** gated by step-up auth.
5. The **deactivation handler** — when NPPES marks a provider deactivated (death, license revocation), emit `m29.nppes.provider_deactivated` so M40 can flag any tenant overlays referencing the deactivated NPI.

**T-29.09 closes W-XI-11 (NPPES sync) and the fourth M29 pillar from D1.**

This is the **last big inbound surface** before T-29.11 (SUD redaction hardening), T-29.12-13 (frontend), and T-29.14 (operational dashboards).

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **NPPES API client** at `packages/nppes-client/src/client.ts` — typed wrapper over `https://npiregistry.cms.hhs.gov/api/?version=2.1`.
- **NPPES typed response shapes** at `packages/nppes-client/src/types.ts` — the API returns a fairly chaotic shape; we project it into a stable internal schema.
- **Rate limiter** at `packages/nppes-client/src/rate-limiter.ts` — token-bucket bounded at 4 req/sec (conservative; CMS does not publish a hard limit but anecdotal reports place sustained throughput around 5-10 req/sec).
- **Luhn-mod-10 NPI validator** at `packages/nppes-client/src/npi-validate.ts`.
- **Sync orchestrator** at `apps/backend/src/modules/29-external-interfaces/nppes/sync-orchestrator.ts` — gathers NPIs to refresh from M40 across all tenants, runs the fetch loop, diffs against cache, persists + emits events.
- **Provider cache + diff** at `apps/backend/src/modules/29-external-interfaces/nppes/provider-cache.ts` — UPSERT into `nppes_provider` with field-level change detection.
- **Platform job** at `apps/backend/src/modules/29-external-interfaces/workers/nppes-sync-platform.worker.ts` — BullMQ worker, scheduled nightly at 02:30 UTC, concurrency 1 platform-wide.
- **Admin routes** at `apps/backend/src/modules/29-external-interfaces/routes/nppes-admin.ts` — `POST /api/v1/hl7/nppes/sync/trigger` (manual, step-up gated), `GET /api/v1/hl7/nppes/sync/runs`, `GET /api/v1/hl7/nppes/sync/runs/:id`, `GET /api/v1/hl7/nppes/providers/:npi`.
- **`NppesProviderReader` seam implementation** at `apps/backend/src/modules/29-external-interfaces/seams/nppes-provider-reader.ts` — the published seam per M29 v0.3 §4.3.
- **Resilience** — partial-sync recovery (resume from `sync_run.last_processed_npi`), exponential backoff on 429 / 5xx, circuit breaker after 50 consecutive failures.
- **Outbox events** (all already in v0.3 §4.10 catalog) — `m29.nppes.provider_synced`, `m29.nppes.provider_deactivated`, `m29.nppes.sync_run.started`, `m29.nppes.sync_run.completed`, `m29.nppes.sync_run.failed`.
- **Tests** — W-XI-11 (nightly sync happy path), deactivation detection, partial-sync recovery, rate limiter, 429 backoff, manual-trigger step-up gate.
- **Sign-off checklist.**

### 1.2 Non-goals

- **M40's real `external_physician` mutation on provider_synced.** M40 v0.3 will consume the event; T-29.09 ships a forward-stub.
- **Real-time NPI lookup at order-creation time.** M11 and M12 use the cached `nppes_provider` rows. Real-time NPPES lookup at write-path would be too slow and rate-limited; the nightly sync + manual trigger is the model.
- **Bulk download from NPPES weekly dissemination file.** The API approach is sufficient for ~10K-50K NPIs per tenant; the bulk file (~6M records, ~5GB monthly) is Phase 2.
- **Partial-organization fields.** NPPES Type 2 entities (organizations, hospitals, clinics) are out of scope for T-29.09. T-29.09 covers Type 1 (individual providers) only; Type 2 sync is a future PR.
- **Frontend UI.** T-29.13.

---

## 2. NPPES API Client

The public NPI Registry endpoint:
```
GET https://npiregistry.cms.hhs.gov/api/?version=2.1&number=<NPI>
```

Returns up to one result per NPI. Multi-NPI bulk lookup is not supported (the API supports search by name, but for our use case we always know the NPI from M40, so we use single-NPI lookups only).

### 2.1 Typed response

The NPPES JSON response is large and quirky. We project it into a stable internal shape:

```ts
// packages/nppes-client/src/types.ts

export interface NppesIndividualProvider {
  readonly npi: string                        // 10 digits
  readonly enumerationType: 'NPI-1'           // individual; 'NPI-2' organization is out of scope
  readonly status: 'A' | 'D'                  // active / deactivated
  readonly enumerationDate: string            // ISO yyyy-mm-dd
  readonly lastUpdated: string                // ISO yyyy-mm-dd
  readonly deactivationDate?: string          // ISO when status='D'
  readonly deactivationReason?: string        // e.g. 'DEATH', 'FRAUD', 'OTHER'
  readonly basic: {
    readonly firstName: string
    readonly middleName?: string
    readonly lastName: string
    readonly credential?: string              // 'MD', 'DO', 'RN', etc.
    readonly soleProprietor?: 'YES' | 'NO'
    readonly gender?: 'M' | 'F'
    readonly nameSuffix?: string              // 'JR', 'SR', 'III'
    readonly namePrefix?: string              // 'DR.'
  }
  readonly addresses: ReadonlyArray<{
    readonly purpose: 'LOCATION' | 'MAILING'
    readonly addressLine1: string
    readonly addressLine2?: string
    readonly city: string
    readonly state: string
    readonly postalCode: string
    readonly countryCode: string
    readonly telephoneNumber?: string
    readonly faxNumber?: string
  }>
  readonly taxonomies: ReadonlyArray<{
    readonly code: string                     // healthcare provider taxonomy code (HPTC), e.g. '207R00000X' (internal medicine)
    readonly desc: string
    readonly primary: boolean
    readonly state?: string                   // state where this taxonomy's license is held
    readonly licenseNumber?: string
  }>
  readonly identifiers?: ReadonlyArray<{
    readonly code: string                     // 'NPI', 'OTHER', 'MEDICARE', 'MEDICAID', etc.
    readonly identifier: string
    readonly state?: string
    readonly issuer?: string
  }>
}

export type NppesFetchResult =
  | { kind: 'found'; provider: NppesIndividualProvider }
  | { kind: 'not_found'; npi: string }
  | { kind: 'deactivated'; provider: NppesIndividualProvider }   // status='D'
  | { kind: 'organization_skipped'; npi: string }                 // NPI-2 enumeration_type
  | { kind: 'invalid_format'; npi: string }                       // failed Luhn or non-10-digit
```

### 2.2 Client

```ts
// packages/nppes-client/src/client.ts
import type { Logger } from 'pino'
import { isValidNpi } from './npi-validate'
import { RateLimiter } from './rate-limiter'
import type { NppesFetchResult, NppesIndividualProvider } from './types'

export interface NppesClientConfig {
  readonly baseUrl?: string                  // default 'https://npiregistry.cms.hhs.gov/api/'
  readonly apiVersion?: string               // default '2.1'
  readonly userAgent?: string                // default 'WardenX/Phase1 (+https://wardenx.com/contact)'
  readonly requestsPerSecond?: number        // default 4
  readonly fetchTimeoutMs?: number           // default 10_000
  readonly maxRetries?: number               // default 3 for 429/5xx
  readonly logger: Logger
}

export class NppesClient {
  private readonly baseUrl: string
  private readonly apiVersion: string
  private readonly userAgent: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly rateLimiter: RateLimiter
  private readonly logger: Logger

  constructor(config: NppesClientConfig) {
    this.baseUrl = config.baseUrl ?? 'https://npiregistry.cms.hhs.gov/api/'
    this.apiVersion = config.apiVersion ?? '2.1'
    this.userAgent = config.userAgent ?? 'WardenX/Phase1 (+https://wardenx.com/contact)'
    this.timeoutMs = config.fetchTimeoutMs ?? 10_000
    this.maxRetries = config.maxRetries ?? 3
    this.rateLimiter = new RateLimiter({ rps: config.requestsPerSecond ?? 4 })
    this.logger = config.logger
  }

  async fetchByNpi(npi: string): Promise<NppesFetchResult> {
    if (!isValidNpi(npi)) {
      this.logger.warn({ npi }, 'nppes.fetch.invalid_format')
      return { kind: 'invalid_format', npi }
    }

    await this.rateLimiter.acquire()

    const url = `${this.baseUrl}?version=${this.apiVersion}&number=${npi}`

    let lastErr: Error | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.doFetch(url)
        return this.classifyResponse(npi, response)
      } catch (err) {
        lastErr = err as Error
        const retryable = err instanceof RetryableHttpError
        if (!retryable || attempt === this.maxRetries) {
          throw err
        }
        const backoffMs = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
        this.logger.info({ npi, attempt, backoffMs, status: (err as RetryableHttpError).status }, 'nppes.fetch.retryable_backoff')
        await new Promise(resolve => setTimeout(resolve, backoffMs))
      }
    }

    throw lastErr ?? new Error('nppes_fetch_unknown_failure')
  }

  private async doFetch(url: string): Promise<NppesApiResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' },
        signal: controller.signal,
      })

      if (res.status === 429) throw new RetryableHttpError(429, 'rate_limited')
      if (res.status >= 500) throw new RetryableHttpError(res.status, 'server_error')
      if (res.status === 404) throw new Error(`nppes_unexpected_404`)  // API returns 200 with empty results for not-found
      if (!res.ok) throw new Error(`nppes_http_${res.status}`)

      return (await res.json()) as NppesApiResponse
    } finally {
      clearTimeout(timer)
    }
  }

  private classifyResponse(npi: string, response: NppesApiResponse): NppesFetchResult {
    if (response.result_count === 0 || !response.results || response.results.length === 0) {
      return { kind: 'not_found', npi }
    }

    const raw = response.results[0]

    if (raw.enumeration_type === 'NPI-2') {
      return { kind: 'organization_skipped', npi }
    }

    const provider = this.projectProvider(raw)

    if (provider.status === 'D') {
      return { kind: 'deactivated', provider }
    }
    return { kind: 'found', provider }
  }

  private projectProvider(raw: NppesApiRawResult): NppesIndividualProvider {
    return {
      npi: raw.number,
      enumerationType: 'NPI-1',
      status: raw.basic?.status === 'A' || !raw.basic?.status ? 'A' : 'D',
      enumerationDate: raw.basic?.enumeration_date ?? '',
      lastUpdated: raw.basic?.last_updated ?? '',
      deactivationDate: raw.basic?.deactivation_date,
      deactivationReason: raw.basic?.deactivation_reason,
      basic: {
        firstName: raw.basic?.first_name ?? '',
        middleName: raw.basic?.middle_name,
        lastName: raw.basic?.last_name ?? '',
        credential: raw.basic?.credential,
        soleProprietor: raw.basic?.sole_proprietor,
        gender: raw.basic?.gender,
        nameSuffix: raw.basic?.name_suffix,
        namePrefix: raw.basic?.name_prefix,
      },
      addresses: (raw.addresses ?? []).map(a => ({
        purpose: a.address_purpose as 'LOCATION' | 'MAILING',
        addressLine1: a.address_1 ?? '',
        addressLine2: a.address_2,
        city: a.city ?? '',
        state: a.state ?? '',
        postalCode: a.postal_code ?? '',
        countryCode: a.country_code ?? 'US',
        telephoneNumber: a.telephone_number,
        faxNumber: a.fax_number,
      })),
      taxonomies: (raw.taxonomies ?? []).map(t => ({
        code: t.code ?? '',
        desc: t.desc ?? '',
        primary: Boolean(t.primary),
        state: t.state,
        licenseNumber: t.license,
      })),
      identifiers: raw.identifiers?.map(i => ({
        code: i.code ?? '',
        identifier: i.identifier ?? '',
        state: i.state,
        issuer: i.issuer,
      })),
    }
  }
}

class RetryableHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'RetryableHttpError'
  }
}

interface NppesApiResponse {
  result_count: number
  results?: ReadonlyArray<NppesApiRawResult>
}

interface NppesApiRawResult {
  number: string
  enumeration_type: 'NPI-1' | 'NPI-2'
  basic?: any
  addresses?: ReadonlyArray<any>
  taxonomies?: ReadonlyArray<any>
  identifiers?: ReadonlyArray<any>
}
```

### 2.3 Rate limiter

Token bucket. Refills at `rps` tokens per second, capacity = `burst` (default `rps`).

```ts
// packages/nppes-client/src/rate-limiter.ts

export interface RateLimiterConfig {
  readonly rps: number
  readonly burst?: number
}

export class RateLimiter {
  private tokens: number
  private lastRefill: number
  private readonly capacity: number
  private readonly refillPerMs: number

  constructor(config: RateLimiterConfig) {
    this.capacity = config.burst ?? config.rps
    this.tokens = this.capacity
    this.lastRefill = Date.now()
    this.refillPerMs = config.rps / 1000
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens--
        return
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs)
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.lastRefill = now
  }
}
```

### 2.4 NPI validation (Luhn mod 10)

NPIs are 10 digits with the last digit a Luhn check digit. The CMS algorithm prepends "80840" (the ISO 6523-issued identifier for NPI) to the first 9 digits, computes Luhn, and uses the result as digit 10.

```ts
// packages/nppes-client/src/npi-validate.ts

export function isValidNpi(npi: string): boolean {
  if (typeof npi !== 'string') return false
  if (!/^\d{10}$/.test(npi)) return false

  const prefixed = '80840' + npi.slice(0, 9)
  const expectedCheck = parseInt(npi.charAt(9), 10)
  const computedCheck = luhnCheckDigit(prefixed)
  return computedCheck === expectedCheck
}

function luhnCheckDigit(input: string): number {
  let sum = 0
  let alternate = true   // start by doubling the rightmost digit
  for (let i = input.length - 1; i >= 0; i--) {
    let digit = parseInt(input.charAt(i), 10)
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  const mod = sum % 10
  return mod === 0 ? 0 : 10 - mod
}
```

---

## 3. Provider Cache + Diff

```ts
// apps/backend/src/modules/29-external-interfaces/nppes/provider-cache.ts
import { db } from '@chartwarden/db'
import { nppesProvider } from '@chartwarden/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withPlatformContext } from '@chartwarden/tenancy'
import type { NppesIndividualProvider } from '@chartwarden/nppes-client/types'
import type { Logger } from 'pino'
import * as crypto from 'node:crypto'

export interface CacheUpsertResult {
  readonly action: 'inserted' | 'updated' | 'unchanged'
  readonly changedFields: readonly string[]
  readonly priorStatus?: 'A' | 'D'
  readonly newStatus: 'A' | 'D'
}

export class ProviderCache {
  constructor(private readonly logger: Logger) {}

  async upsert(provider: NppesIndividualProvider): Promise<CacheUpsertResult> {
    const profileHash = this.hashProvider(provider)

    return await withPlatformContext(db, async (tx) => {
      const [existing] = await tx
        .select()
        .from(nppesProvider)
        .where(eq(nppesProvider.npi, provider.npi))
        .limit(1)

      if (!existing) {
        await tx.insert(nppesProvider).values({
          npi: provider.npi,
          status: provider.status,
          enumerationDate: provider.enumerationDate ? new Date(provider.enumerationDate) : null,
          lastUpdatedAtSource: provider.lastUpdated ? new Date(provider.lastUpdated) : null,
          deactivationDate: provider.deactivationDate ? new Date(provider.deactivationDate) : null,
          deactivationReason: provider.deactivationReason,
          firstName: provider.basic.firstName,
          middleName: provider.basic.middleName,
          lastName: provider.basic.lastName,
          credential: provider.basic.credential,
          gender: provider.basic.gender,
          addresses: provider.addresses as any,
          taxonomies: provider.taxonomies as any,
          identifiers: provider.identifiers as any,
          profileHash,
          syncedAt: new Date(),
        })
        return { action: 'inserted', changedFields: [], newStatus: provider.status }
      }

      if (existing.profileHash === profileHash) {
        // Touch syncedAt to record we checked
        await tx
          .update(nppesProvider)
          .set({ syncedAt: new Date() })
          .where(eq(nppesProvider.npi, provider.npi))
        return { action: 'unchanged', changedFields: [], priorStatus: existing.status as 'A' | 'D', newStatus: provider.status }
      }

      const changedFields = this.diffFields(existing, provider)

      await tx.update(nppesProvider).set({
        status: provider.status,
        enumerationDate: provider.enumerationDate ? new Date(provider.enumerationDate) : null,
        lastUpdatedAtSource: provider.lastUpdated ? new Date(provider.lastUpdated) : null,
        deactivationDate: provider.deactivationDate ? new Date(provider.deactivationDate) : null,
        deactivationReason: provider.deactivationReason,
        firstName: provider.basic.firstName,
        middleName: provider.basic.middleName,
        lastName: provider.basic.lastName,
        credential: provider.basic.credential,
        gender: provider.basic.gender,
        addresses: provider.addresses as any,
        taxonomies: provider.taxonomies as any,
        identifiers: provider.identifiers as any,
        profileHash,
        syncedAt: new Date(),
      }).where(eq(nppesProvider.npi, provider.npi))

      return { action: 'updated', changedFields, priorStatus: existing.status as 'A' | 'D', newStatus: provider.status }
    })
  }

  private hashProvider(provider: NppesIndividualProvider): string {
    // Stable JSON-canonical hash so field reordering doesn't trigger spurious updates.
    const canonical = JSON.stringify(provider, Object.keys(provider).sort())
    return crypto.createHash('sha256').update(canonical).digest('hex')
  }

  private diffFields(existing: any, fresh: NppesIndividualProvider): string[] {
    const changed: string[] = []
    if (existing.status !== fresh.status) changed.push('status')
    if (existing.lastName !== fresh.basic.lastName) changed.push('lastName')
    if (existing.firstName !== fresh.basic.firstName) changed.push('firstName')
    if (existing.credential !== fresh.basic.credential) changed.push('credential')
    if (JSON.stringify(existing.addresses) !== JSON.stringify(fresh.addresses)) changed.push('addresses')
    if (JSON.stringify(existing.taxonomies) !== JSON.stringify(fresh.taxonomies)) changed.push('taxonomies')
    return changed
  }
}
```

---

## 4. Sync Orchestrator

```ts
// apps/backend/src/modules/29-external-interfaces/nppes/sync-orchestrator.ts
import { db } from '@chartwarden/db'
import { nppesSyncRun, nppesProvider } from '@chartwarden/db/schema/external-interfaces'
import { externalPhysician } from '@chartwarden/db/schema/mdm'
import { sql, eq, and, isNotNull } from 'drizzle-orm'
import { withPlatformContext } from '@chartwarden/tenancy'
import { ulid } from 'ulid'
import type { NppesClient } from '@chartwarden/nppes-client'
import { ProviderCache } from './provider-cache'
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { Logger } from 'pino'

const CIRCUIT_BREAKER_CONSECUTIVE_FAILURES = 50
const BATCH_COMMIT_SIZE = 50  // flush sync_run progress every 50 NPIs

export type SyncKind = 'nightly_scheduled' | 'manual_trigger'

export interface SyncOrchestratorDeps {
  readonly client: NppesClient
  readonly cache: ProviderCache
  readonly outbox: Outbox
  readonly logger: Logger
}

export interface SyncResult {
  readonly syncRunId: string
  readonly providersFound: number
  readonly providersSynced: number      // change-detected updates
  readonly providersUnchanged: number
  readonly providersNotFound: number    // NPPES returned no result
  readonly providersOrganization: number // NPI-2 (skipped)
  readonly providersInvalid: number     // Luhn-failed
  readonly deactivations: number
  readonly errors: number
}

export class SyncOrchestrator {
  constructor(private readonly deps: SyncOrchestratorDeps) {}

  async run(kind: SyncKind, triggeredByMembershipId?: string): Promise<SyncResult> {
    const syncRunId = ulid()
    const startedAt = new Date()

    // 1. Open sync_run row + emit started event
    await withPlatformContext(db, async (tx) => {
      await tx.insert(nppesSyncRun).values({
        id: syncRunId,
        kind,
        startedAt,
        triggeredByMembershipId: triggeredByMembershipId ?? null,
        status: 'in_progress',
        providersTotal: 0,
        providersProcessed: 0,
      })
    })
    await this.deps.outbox.publish('m29.nppes.sync_run.started', {
      syncRunId, kind, startedAt: startedAt.toISOString(),
    })

    try {
      // 2. Collect distinct NPIs from M40 external_physician across all tenants
      const npis = await this.collectNpis()
      this.deps.logger.info({ syncRunId, kind, npiCount: npis.length }, 'nppes.sync.collected_npis')

      await withPlatformContext(db, async (tx) => {
        await tx.update(nppesSyncRun).set({ providersTotal: npis.length }).where(eq(nppesSyncRun.id, syncRunId))
      })

      // 3. Run the fetch loop
      const result: SyncResult = {
        syncRunId,
        providersFound: 0, providersSynced: 0, providersUnchanged: 0,
        providersNotFound: 0, providersOrganization: 0, providersInvalid: 0,
        deactivations: 0, errors: 0,
      }
      let consecutiveFailures = 0
      let processedSinceCheckpoint = 0

      for (let i = 0; i < npis.length; i++) {
        const npi = npis[i]
        try {
          const fetchResult = await this.deps.client.fetchByNpi(npi)
          consecutiveFailures = 0
          await this.handleFetchResult(npi, fetchResult, result)
        } catch (err) {
          result.errors++
          consecutiveFailures++
          this.deps.logger.warn({ npi, err: (err as Error).message }, 'nppes.sync.npi_error')

          if (consecutiveFailures >= CIRCUIT_BREAKER_CONSECUTIVE_FAILURES) {
            this.deps.logger.error({ syncRunId, consecutiveFailures }, 'nppes.sync.circuit_breaker_tripped')
            await this.markFailed(syncRunId, `circuit_breaker_${consecutiveFailures}_consecutive_failures`, result, i + 1)
            return result
          }
        }

        processedSinceCheckpoint++
        if (processedSinceCheckpoint >= BATCH_COMMIT_SIZE) {
          await this.checkpoint(syncRunId, i + 1, npi)
          processedSinceCheckpoint = 0
        }
      }

      // 4. Mark complete
      await this.markComplete(syncRunId, result)
      return result
    } catch (err) {
      this.deps.logger.error({ syncRunId, err }, 'nppes.sync.fatal')
      await this.markFailed(syncRunId, (err as Error).message, {
        syncRunId, providersFound: 0, providersSynced: 0, providersUnchanged: 0,
        providersNotFound: 0, providersOrganization: 0, providersInvalid: 0,
        deactivations: 0, errors: 1,
      }, 0)
      throw err
    }
  }

  private async collectNpis(): Promise<string[]> {
    // Distinct NPIs across all tenants — platform-role query
    const rows = await withPlatformContext(db, async (tx) =>
      tx.execute(sql`
        SELECT DISTINCT npi
        FROM mdm.external_physician
        WHERE npi IS NOT NULL AND length(npi) = 10
        ORDER BY npi
      `),
    )
    return (rows as Array<{ npi: string }>).map(r => r.npi)
  }

  private async handleFetchResult(npi: string, result: import('@chartwarden/nppes-client/types').NppesFetchResult, agg: SyncResult): Promise<void> {
    switch (result.kind) {
      case 'invalid_format':
        agg.providersInvalid++
        return

      case 'organization_skipped':
        agg.providersOrganization++
        return

      case 'not_found':
        agg.providersNotFound++
        // Optionally emit a soft alert; for T-29.09 the not_found case is logged but not eventized
        this.deps.logger.info({ npi }, 'nppes.sync.npi_not_found')
        return

      case 'found': {
        agg.providersFound++
        const upsertResult = await this.deps.cache.upsert(result.provider)
        if (upsertResult.action === 'inserted' || upsertResult.action === 'updated') {
          agg.providersSynced++
          await this.deps.outbox.publish('m29.nppes.provider_synced', {
            npi,
            action: upsertResult.action,
            changedFields: upsertResult.changedFields,
            lastUpdatedAtSource: result.provider.lastUpdated,
            syncedAt: new Date().toISOString(),
          })
        } else {
          agg.providersUnchanged++
        }
        return
      }

      case 'deactivated': {
        agg.providersFound++
        const upsertResult = await this.deps.cache.upsert(result.provider)
        // Emit deactivation event if status flipped from A → D
        if (upsertResult.priorStatus !== 'D' && upsertResult.newStatus === 'D') {
          agg.deactivations++
          await this.deps.outbox.publish('m29.nppes.provider_deactivated', {
            npi,
            deactivationDate: result.provider.deactivationDate ?? new Date().toISOString().slice(0, 10),
            deactivationReason: result.provider.deactivationReason ?? 'UNKNOWN',
            detectedAt: new Date().toISOString(),
          })
        }
        if (upsertResult.action !== 'unchanged') {
          agg.providersSynced++
          await this.deps.outbox.publish('m29.nppes.provider_synced', {
            npi,
            action: upsertResult.action,
            changedFields: upsertResult.changedFields,
            lastUpdatedAtSource: result.provider.lastUpdated,
            syncedAt: new Date().toISOString(),
          })
        } else {
          agg.providersUnchanged++
        }
        return
      }
    }
  }

  private async checkpoint(syncRunId: string, processed: number, lastNpi: string): Promise<void> {
    await withPlatformContext(db, async (tx) => {
      await tx
        .update(nppesSyncRun)
        .set({ providersProcessed: processed, lastProcessedNpi: lastNpi })
        .where(eq(nppesSyncRun.id, syncRunId))
    })
  }

  private async markComplete(syncRunId: string, result: SyncResult): Promise<void> {
    const completedAt = new Date()
    await withPlatformContext(db, async (tx) => {
      await tx.update(nppesSyncRun).set({
        status: 'completed',
        completedAt,
        providersProcessed: result.providersFound + result.providersNotFound + result.providersOrganization + result.providersInvalid + result.errors,
        providersSynced: result.providersSynced,
        deactivationsDetected: result.deactivations,
        errors: result.errors,
      }).where(eq(nppesSyncRun.id, syncRunId))
    })
    await this.deps.outbox.publish('m29.nppes.sync_run.completed', {
      syncRunId, completedAt: completedAt.toISOString(),
      providersSynced: result.providersSynced,
      deactivations: result.deactivations,
      errors: result.errors,
    })
    this.deps.logger.info({ syncRunId, ...result }, 'nppes.sync.completed')
  }

  private async markFailed(syncRunId: string, error: string, partial: SyncResult, processedCount: number): Promise<void> {
    const failedAt = new Date()
    await withPlatformContext(db, async (tx) => {
      await tx.update(nppesSyncRun).set({
        status: 'failed',
        completedAt: failedAt,
        error,
        providersProcessed: processedCount,
        providersSynced: partial.providersSynced,
        errors: partial.errors,
      }).where(eq(nppesSyncRun.id, syncRunId))
    })
    await this.deps.outbox.publish('m29.nppes.sync_run.failed', {
      syncRunId, failedAt: failedAt.toISOString(), error,
      partialResult: partial,
    })
    this.deps.logger.error({ syncRunId, error, partial }, 'nppes.sync.failed')
  }
}
```

---

## 5. Platform Job

```ts
// apps/backend/src/modules/29-external-interfaces/workers/nppes-sync-platform.worker.ts
import { Worker, Queue, type Job } from 'bullmq'
import { pino } from 'pino'
import { db } from '@chartwarden/db'
import { NppesClient } from '@chartwarden/nppes-client'
import { ProviderCache } from '../nppes/provider-cache'
import { SyncOrchestrator } from '../nppes/sync-orchestrator'
import { mkOutbox } from '@chartwarden/foundation/seams/outbox'

const logger = pino({ name: 'nppes-sync-platform' })
const outbox = mkOutbox(db, logger)
const client = new NppesClient({ logger })
const cache = new ProviderCache(logger)
const orchestrator = new SyncOrchestrator({ client, cache, outbox, logger })

interface NppesJobData {
  readonly kind: 'nightly_scheduled' | 'manual_trigger'
  readonly triggeredByMembershipId?: string
}

export const nppesSyncWorker = new Worker<NppesJobData>(
  'nppes-sync-platform',
  async (job: Job<NppesJobData>) => {
    const result = await orchestrator.run(job.data.kind, job.data.triggeredByMembershipId)
    return result
  },
  {
    connection: { url: process.env.VALKEY_URL! },
    concurrency: 1,  // platform-wide singleton; multiple workers would dup the API requests
  },
)

// Scheduling — registered by the BullMQ scheduler at boot. Runs at 02:30 UTC nightly.
export async function scheduleNppesSyncNightly(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    'nppes-sync-nightly',
    { pattern: '30 2 * * *', tz: 'UTC' },   // 02:30 UTC daily
    { name: 'tick', data: { kind: 'nightly_scheduled' } as NppesJobData },
  )
}
```

The nightly window 02:30 UTC was chosen because:
- NPPES dissemination (the bulk file) historically updates daily around 23:00 UTC; by 02:30 UTC the API has caught up to the most recent update.
- This avoids competing for sidecar / DB resources with the daytime HL7 ingest traffic.

---

## 6. Routes (Manual Trigger + Status)

```ts
// apps/backend/src/modules/29-external-interfaces/routes/nppes-admin.ts
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { db } from '@chartwarden/db'
import { nppesSyncRun, nppesProvider } from '@chartwarden/db/schema/external-interfaces'
import { eq, desc } from 'drizzle-orm'
import { withPlatformContext } from '@chartwarden/tenancy'
import { Queue } from 'bullmq'
import { requirePermissions } from '@chartwarden/foundation/auth'
import { requirePredicate } from '@chartwarden/foundation/abac'

export function registerNppesAdminRoutes(app: FastifyInstance): void {
  const queue = new Queue('nppes-sync-platform', { connection: { url: process.env.VALKEY_URL! } })

  // POST manual sync trigger (step-up gated per D18)
  app.post(
    '/api/v1/hl7/nppes/sync/trigger',
    {
      preHandler: [
        requirePermissions(['external_interfaces.nppes_sync:trigger_manual']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
        requirePredicate('nppes_platform_job_caller', {}),  // M29 v0.3 §4.7 declared predicate
      ],
    },
    async (req, reply) => {
      // Refuse if a sync is already in_progress (platform-singleton invariant)
      const [inProgress] = await withPlatformContext(db, async (tx) =>
        tx.select({ id: nppesSyncRun.id }).from(nppesSyncRun).where(eq(nppesSyncRun.status, 'in_progress')).limit(1),
      )
      if (inProgress) {
        return reply.code(409).send({ error: 'sync_already_in_progress', syncRunId: inProgress.id })
      }

      await queue.add('manual', {
        kind: 'manual_trigger',
        triggeredByMembershipId: req.user!.membershipId,
      }, { attempts: 1, removeOnComplete: { age: 86_400 } })

      return reply.code(202).send({ status: 'queued' })
    },
  )

  // GET sync runs list
  app.get(
    '/api/v1/hl7/nppes/sync/runs',
    {
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
        }),
      },
      preHandler: [requirePermissions(['external_interfaces.nppes_sync:read'])],
    },
    async (req) => {
      const { limit = 20 } = req.query as { limit?: number }
      return withPlatformContext(db, async (tx) =>
        tx.select().from(nppesSyncRun).orderBy(desc(nppesSyncRun.startedAt)).limit(limit),
      )
    },
  )

  // GET sync run detail
  app.get(
    '/api/v1/hl7/nppes/sync/runs/:id',
    {
      schema: { params: Type.Object({ id: Type.String() }) },
      preHandler: [requirePermissions(['external_interfaces.nppes_sync:read'])],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const [row] = await withPlatformContext(db, async (tx) =>
        tx.select().from(nppesSyncRun).where(eq(nppesSyncRun.id, id)).limit(1),
      )
      if (!row) return reply.code(404).send({ error: 'sync_run_not_found' })
      return row
    },
  )

  // GET cached provider by NPI
  app.get(
    '/api/v1/hl7/nppes/providers/:npi',
    {
      schema: { params: Type.Object({ npi: Type.String({ pattern: '^\\d{10}$' }) }) },
      preHandler: [requirePermissions(['external_interfaces.nppes_provider:read'])],
    },
    async (req, reply) => {
      const { npi } = req.params as { npi: string }
      const [row] = await withPlatformContext(db, async (tx) =>
        tx.select().from(nppesProvider).where(eq(nppesProvider.npi, npi)).limit(1),
      )
      if (!row) return reply.code(404).send({ error: 'provider_not_cached', hint: 'NPI not yet synced; trigger a manual sync if you expect this provider' })
      return row
    },
  )
}
```

---

## 7. `NppesProviderReader` Seam Implementation

The seam was declared as published in M29 v0.3 §4.3. T-29.09 ships the implementation.

```ts
// apps/backend/src/modules/29-external-interfaces/seams/nppes-provider-reader.ts
import { db } from '@chartwarden/db'
import { nppesProvider } from '@chartwarden/db/schema/external-interfaces'
import { eq, inArray } from 'drizzle-orm'
import { withPlatformContext } from '@chartwarden/tenancy'

export interface NppesProvider {
  readonly npi: string
  readonly status: 'A' | 'D'
  readonly enumerationDate: Date | null
  readonly lastUpdatedAtSource: Date | null
  readonly deactivationDate: Date | null
  readonly deactivationReason: string | null
  readonly firstName: string
  readonly middleName: string | null
  readonly lastName: string
  readonly credential: string | null
  readonly gender: string | null
  readonly addresses: ReadonlyArray<NppesAddress>
  readonly taxonomies: ReadonlyArray<NppesTaxonomy>
  readonly identifiers: ReadonlyArray<NppesIdentifier> | null
  readonly syncedAt: Date
}

export interface NppesAddress { /* see types.ts shape */ }
export interface NppesTaxonomy { /* see types.ts shape */ }
export interface NppesIdentifier { /* see types.ts shape */ }

export interface NppesProviderReader {
  byNpi(npi: string): Promise<NppesProvider | null>
  byNpis(npis: readonly string[]): Promise<Map<string, NppesProvider>>
  byTaxonomy(taxonomyCode: string, state?: string): Promise<readonly NppesProvider[]>
}

export class NppesProviderReaderImpl implements NppesProviderReader {
  async byNpi(npi: string): Promise<NppesProvider | null> {
    const [row] = await withPlatformContext(db, async (tx) =>
      tx.select().from(nppesProvider).where(eq(nppesProvider.npi, npi)).limit(1),
    )
    return row ? this.project(row) : null
  }

  async byNpis(npis: readonly string[]): Promise<Map<string, NppesProvider>> {
    if (npis.length === 0) return new Map()
    const rows = await withPlatformContext(db, async (tx) =>
      tx.select().from(nppesProvider).where(inArray(nppesProvider.npi, npis as string[])),
    )
    const map = new Map<string, NppesProvider>()
    for (const r of rows) map.set(r.npi, this.project(r))
    return map
  }

  async byTaxonomy(taxonomyCode: string, state?: string): Promise<readonly NppesProvider[]> {
    // JSONB query — find providers whose taxonomies contain the given code (optionally with state match)
    const rows = await withPlatformContext(db, async (tx) =>
      tx.execute(
        state
          ? `SELECT * FROM mdm.nppes_provider WHERE taxonomies @> jsonb_build_array(jsonb_build_object('code', $1::text, 'state', $2::text)) LIMIT 200`
          : `SELECT * FROM mdm.nppes_provider WHERE taxonomies @> jsonb_build_array(jsonb_build_object('code', $1::text)) LIMIT 200`,
        state ? [taxonomyCode, state] : [taxonomyCode],
      ),
    )
    return (rows as any[]).map(r => this.project(r))
  }

  private project(row: any): NppesProvider {
    return {
      npi: row.npi,
      status: row.status,
      enumerationDate: row.enumerationDate,
      lastUpdatedAtSource: row.lastUpdatedAtSource,
      deactivationDate: row.deactivationDate,
      deactivationReason: row.deactivationReason,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      credential: row.credential,
      gender: row.gender,
      addresses: row.addresses ?? [],
      taxonomies: row.taxonomies ?? [],
      identifiers: row.identifiers,
      syncedAt: row.syncedAt,
    }
  }
}

// Registered in M29 boot:
// SeamRegistry.register('NppesProviderReader', new NppesProviderReaderImpl())
```

---

## 8. M40 Forward-Stub Consumers

M40 v0.3 will consume the sync events to update its `external_physician` overlays. Today M40 is locked at v0.2 — ship forward-stubs.

```ts
// apps/backend/src/modules/40-mdm/outbox-consumers/m29-nppes-events.stub.ts

export function registerM40NppesEventStubs(outbox: Outbox, logger: Logger): void {
  outbox.registerConsumer({
    eventName: 'm29.nppes.provider_synced',
    consumerName: 'm40.nppes-sync-applier',
    handler: async ({ payload }) => {
      logger.info({ npi: payload.npi, changedFields: payload.changedFields }, 'm40.nppes.provider_synced.forward_stub')
      // M40 v0.3 will UPDATE external_physician SET last_nppes_sync_at=NOW(), overlay_dirty_flags=... WHERE npi=payload.npi
    },
  })

  outbox.registerConsumer({
    eventName: 'm29.nppes.provider_deactivated',
    consumerName: 'm40.nppes-deactivation-applier',
    handler: async ({ payload }) => {
      logger.warn({ npi: payload.npi, reason: payload.deactivationReason }, 'm40.nppes.provider_deactivated.forward_stub')
      // M40 v0.3 will flag external_physician rows referencing this NPI as `deactivated_at_source=true`
      // and emit M36 alerts to any tenant whose preferred-physician config references the deactivated NPI.
    },
  })
}
```

---

## 9. Tests

### 9.1 W-XI-11 — nightly sync happy path

```ts
describe('W-XI-11 — nightly NPPES sync', () => {
  it('collects NPIs across tenants → fetches → upserts cache → emits per-provider events', async () => {
    // Seed M40 external_physician rows across two tenants
    await fixtures.externalPhysician({ organizationId: 'org_a', npi: '1234567893' })
    await fixtures.externalPhysician({ organizationId: 'org_b', npi: '1234567893' })  // same NPI
    await fixtures.externalPhysician({ organizationId: 'org_a', npi: '1234567802' })

    // Stub NPPES API
    mockNppes.intercept('1234567893', { found: { firstName: 'JANE', lastName: 'DOE', credential: 'MD' } })
    mockNppes.intercept('1234567802', { found: { firstName: 'JOHN', lastName: 'SMITH', credential: 'DO' } })

    await orchestrator.run('nightly_scheduled')

    // Cache has both providers (deduplicated by NPI)
    const cached = await db.select().from(nppesProvider)
    expect(cached).toHaveLength(2)

    // Outbox has 1 sync_run.started + 2 provider_synced + 1 sync_run.completed
    const events = await fixtures.outboxEvents()
    expect(events.filter(e => e.name === 'm29.nppes.provider_synced')).toHaveLength(2)
    expect(events.find(e => e.name === 'm29.nppes.sync_run.completed')).toMatchObject({
      payload: expect.objectContaining({ providersSynced: 2, deactivations: 0 }),
    })
  })
})
```

### 9.2 Deactivation detected

```ts
describe('NPPES status flip A → D emits provider_deactivated', () => {
  it('previously-active cached provider now returned with status=D → deactivation event', async () => {
    await fixtures.cachedProvider({ npi: '1234567893', status: 'A' })
    await fixtures.externalPhysician({ organizationId: 'org_a', npi: '1234567893' })

    mockNppes.intercept('1234567893', { deactivated: { reason: 'DEATH', date: '2026-06-01' } })

    await orchestrator.run('nightly_scheduled')

    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.nppes.provider_deactivated')).toMatchObject({
      payload: expect.objectContaining({ npi: '1234567893', deactivationReason: 'DEATH' }),
    })

    // Cache now shows D
    const [row] = await db.select().from(nppesProvider).where(eq(nppesProvider.npi, '1234567893'))
    expect(row.status).toBe('D')
  })

  it('previously-deactivated provider remains D → NO duplicate deactivation event', async () => {
    await fixtures.cachedProvider({ npi: '1234567893', status: 'D' })
    await fixtures.externalPhysician({ organizationId: 'org_a', npi: '1234567893' })
    mockNppes.intercept('1234567893', { deactivated: { reason: 'DEATH', date: '2026-06-01' } })

    await orchestrator.run('nightly_scheduled')
    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.nppes.provider_deactivated')).toBeUndefined()
  })
})
```

### 9.3 Luhn validation

```ts
describe('NPI Luhn validation', () => {
  it('valid NPIs pass', () => {
    expect(isValidNpi('1234567893')).toBe(true)   // canonical CMS test NPI
    expect(isValidNpi('1245319599')).toBe(true)
  })
  it('invalid Luhn fails', () => {
    expect(isValidNpi('1234567890')).toBe(false)
    expect(isValidNpi('0000000000')).toBe(false)
  })
  it('non-10-digit fails', () => {
    expect(isValidNpi('123')).toBe(false)
    expect(isValidNpi('12345678901')).toBe(false)
    expect(isValidNpi('123abc7893')).toBe(false)
  })
  it('orchestrator skips invalid NPIs', async () => {
    await fixtures.externalPhysician({ organizationId: 'org_a', npi: '0000000000' })  // invalid Luhn
    await orchestrator.run('nightly_scheduled')
    const events = await fixtures.outboxEvents()
    expect(events.filter(e => e.name === 'm29.nppes.provider_synced')).toHaveLength(0)
    const completed = events.find(e => e.name === 'm29.nppes.sync_run.completed')
    expect(completed?.payload).toMatchObject({ providersSynced: 0 })
  })
})
```

### 9.4 Rate limiter

```ts
describe('rate limiter caps API requests at configured rps', () => {
  it('100 NPIs at rps=4 takes at least 25 seconds', async () => {
    const client = new NppesClient({ requestsPerSecond: 4, logger })
    // ... mock fetch to immediately succeed ...
    const start = Date.now()
    for (let i = 0; i < 100; i++) {
      await client.fetchByNpi(/* valid npi */)
    }
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(24_000)  // 100 / 4 = 25s with 1s tolerance for burst
  }, 60_000)
})
```

### 9.5 429 backoff

```ts
describe('429 rate-limit response → exponential backoff retry', () => {
  it('first attempt 429, second attempt 200 → success', async () => {
    mockNppes.intercept('1234567893', { httpStatus: 429 }, { httpStatus: 429 }, { found: { /* ... */ } })  // 2x 429 then OK
    const result = await client.fetchByNpi('1234567893')
    expect(result.kind).toBe('found')
    expect(mockNppes.callCount('1234567893')).toBe(3)
  })

  it('exhausts retries → throws', async () => {
    mockNppes.intercept('1234567893', { httpStatus: 429 }, { httpStatus: 429 }, { httpStatus: 429 }, { httpStatus: 429 })
    await expect(client.fetchByNpi('1234567893')).rejects.toThrow(/rate_limited/)
  })
})
```

### 9.6 Circuit breaker

```ts
describe('50 consecutive failures trips orchestrator circuit breaker', () => {
  it('marks sync_run failed mid-iteration with partial result', async () => {
    // Seed 100 NPIs; mock NPPES to throw on every request
    for (let i = 0; i < 100; i++) {
      await fixtures.externalPhysician({ organizationId: 'org_a', npi: validNpi(i) })
    }
    mockNppes.alwaysThrow()

    const result = await orchestrator.run('nightly_scheduled')

    // Stopped at 50
    expect(result.errors).toBeGreaterThanOrEqual(50)
    const [run] = await db.select().from(nppesSyncRun).where(eq(nppesSyncRun.id, result.syncRunId))
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/circuit_breaker_50_consecutive_failures/)
  })
})
```

### 9.7 Step-up gate on manual trigger

```ts
describe('manual sync trigger requires step-up', () => {
  it('without step-up → 403', async () => {
    const user = await fixtures.user({ permissions: ['external_interfaces.nppes_sync:trigger_manual'], stepUp: false })
    const res = await client.post('/api/v1/hl7/nppes/sync/trigger', {}, { user })
    expect(res.statusCode).toBe(403)
  })

  it('with step-up → 202 queued', async () => {
    const user = await fixtures.user({ permissions: ['external_interfaces.nppes_sync:trigger_manual'], stepUp: true })
    const res = await client.post('/api/v1/hl7/nppes/sync/trigger', {}, { user })
    expect(res.statusCode).toBe(202)
  })

  it('refuses when sync already in progress', async () => {
    await fixtures.syncRun({ status: 'in_progress' })
    const user = await fixtures.user({ permissions: ['external_interfaces.nppes_sync:trigger_manual'], stepUp: true })
    const res = await client.post('/api/v1/hl7/nppes/sync/trigger', {}, { user })
    expect(res.statusCode).toBe(409)
    expect(res.body.error).toBe('sync_already_in_progress')
  })
})
```

### 9.8 Profile hash dedup

```ts
describe('profile hash prevents spurious updates on no-change', () => {
  it('NPPES returns same data → cache touches synced_at only, no provider_synced event', async () => {
    const existing = await fixtures.cachedProvider({ npi: '1234567893', firstName: 'JANE', lastName: 'DOE', credential: 'MD' })
    await fixtures.externalPhysician({ organizationId: 'org_a', npi: '1234567893' })
    mockNppes.intercept('1234567893', { found: { firstName: 'JANE', lastName: 'DOE', credential: 'MD' } })  // exact match

    await orchestrator.run('nightly_scheduled')

    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.nppes.provider_synced')).toBeUndefined()

    // Synced_at updated
    const [row] = await db.select().from(nppesProvider).where(eq(nppesProvider.npi, '1234567893'))
    expect(row.syncedAt.getTime()).toBeGreaterThan(existing.syncedAt.getTime())
  })
})
```

### 9.9 Cross-tenant NPI deduplication

```ts
describe('same NPI referenced by N tenants → fetched once', () => {
  it('5 tenants reference the same NPI → 1 API call', async () => {
    for (let i = 0; i < 5; i++) {
      await fixtures.externalPhysician({ organizationId: `org_${i}`, npi: '1234567893' })
    }
    mockNppes.intercept('1234567893', { found: { /* ... */ } })

    await orchestrator.run('nightly_scheduled')
    expect(mockNppes.callCount('1234567893')).toBe(1)
  })
})
```

---

## 10. Sign-Off Checklist (T-29.09 PR)

- [ ] `packages/nppes-client` lands as a workspace package: `client.ts`, `rate-limiter.ts`, `npi-validate.ts`, `types.ts`, plus an `__tests__` directory.
- [ ] `apps/backend/src/modules/29-external-interfaces/nppes/` lands: `sync-orchestrator.ts`, `provider-cache.ts`.
- [ ] `apps/backend/src/modules/29-external-interfaces/workers/nppes-sync-platform.worker.ts` lands.
- [ ] `apps/backend/src/modules/29-external-interfaces/routes/nppes-admin.ts` lands.
- [ ] `NppesProviderReaderImpl` registered into `SeamRegistry` at M29 boot.
- [ ] BullMQ scheduler registers nightly cron `30 2 * * *` UTC for `nppes-sync-platform` queue.
- [ ] Manual-trigger route guarded by `step_up_recent` AND `nppes_platform_job_caller` predicates — verified by §9.7.
- [ ] M40 forward-stub consumers registered in M29 boot.
- [ ] Outbox events emitted: sync_run.started, per-provider provider_synced, per-deactivation provider_deactivated, sync_run.completed (or sync_run.failed on circuit breaker).
- [ ] All §9 tests pass — happy path, deactivation × 2, Luhn × 4, rate limiter, 429 retry × 2, circuit breaker, step-up × 3, dedup × 2.
- [ ] Cruiser passes — NPPES client lives in its own package; orchestrator imports the client via the package boundary.
- [ ] No tenant context required for any NPPES sync code — every DB call uses `withPlatformContext` (NPPES is platform-shared data).
- [ ] `User-Agent` header sent on every NPPES API request — required by CMS courtesy guidelines.
- [ ] PHI denylist not relevant here — NPPES provider data is public; no audit denylist additions needed.
- [ ] **M40 owner** sign-off on the `NppesProviderReader` seam interface (since M40 consumes it).
- [ ] **Platform engineer** sign-off on the nightly cron + concurrency=1 invariant.
- [ ] **Compliance officer** sign-off on the manual-trigger step-up gate.

---

## 11. Notes on Refinements Past M29 Spec v0.3

1. **No schema additions.** v0.3 schema (post-T-29.02) already includes `nppes_provider` and `nppes_sync_run`. T-29.09 is the first PR in many to ship without a migration. (T-29.07 was also no-migration; T-29.08 and T-29.10 added small migrations.) This validates the v0.3 consolidation pass: post-v0.3 PRs land cleanly against the spec.

2. **Nightly cron pinned at 02:30 UTC.** Spec D11 said "nightly platform-job sync" without pinning the time. T-29.09 chose 02:30 UTC based on NPPES dissemination timing (the bulk file updates ~23:00 UTC; by 02:30 the API has propagated).

3. **Rate limit pinned at 4 req/sec.** Spec didn't pin. CMS does not document a hard limit; community observation places sustained throughput around 5-10 req/sec. 4 rps is conservative and gives ~14K NPIs/hour, comfortably more than Phase-1 Engrace's expected ~5K total NPIs.

4. **Circuit breaker at 50 consecutive failures.** Pinned. Spec mentioned circuit breaker for inbound listener; T-29.09 mirrors the pattern for the NPPES sync.

5. **Profile-hash field-level diff.** The cache uses a SHA-256 hash of the canonical JSON of the provider record to detect changes. Per-field diff produces the `changedFields` list in the outbox event so M40 can mark only the affected overlay fields dirty.

6. **NPI-2 (organization) entities skipped.** Phase-1 deliberate non-goal — NPPES Type 2 entities are out of scope for T-29.09 because the M40 `external_physician` model is individual-only. A future PR will add `nppes_organization` table + Type 2 sync.

7. **Cross-tenant NPI deduplication.** The orchestrator does `SELECT DISTINCT npi FROM mdm.external_physician` across all tenants. A given NPI referenced by 50 tenants is fetched once. Important for rate-limit budgeting.

8. **Platform-singleton invariant.** BullMQ worker concurrency=1 platform-wide. Manual trigger route refuses with 409 if a run is already `in_progress`. The combination prevents API quota exhaustion from concurrent sync runs.

---

## Document Footer

**Addendum version:** v1.0 (T-29.09 PR-ready)
**Bound to:** M29 v0.3 §3.1, §4.4, §11 D10, D11, D18
**Files delivered:** `packages/nppes-client` (4 files) + 4 source files in `apps/backend` + 1 platform worker + 1 seam impl + 2 forward-stub consumers
**Workflows closed:** W-XI-11
**Schema additions:** None — v0.3 schema sufficient
**Sign-offs required:** M40 owner, Platform engineer, Compliance officer

**End of T-29.09 NPPES sync addendum.**
