# WardenX — T-29.01 Addendum: Forward-Seam Deny-Stubs for M29 Consumers

**Document status:** lock-grade — **§3 (Manifest Patch) SUPERSEDED by ADR-0005 (2026-06-12)**
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §13.7
**Date:** 2026-06-10

> **⚠️ Superseded — do NOT apply §3's manifest diff.** ADR-0005 establishes that a
> `dependsOn` edge is required **only** for a compile-time import of the producer's package
> (D1). A forward-seam *deny-stub* throws `NotImplementedError` and imports no M29 code, so it
> requires **no `dependsOn` edge and no `phase: 'forward-stub'` tag**. The manifest therefore
> deliberately carries **zero `29` edges** on M30/M33/M34/M35/M37, and `phase` is not a manifest
> field. §3.1's `+ ...29...` diff lines and the §1.1 "add `29` to `dependsOn` / declare
> `phase: 'forward-stub'`" bullet are **withdrawn**. The cited M28 D14 precedent is likewise
> no-edge under ADR-0005 (M28 carries no `29` edge either). The deny-stub *concept* (a
> `NotImplementedError` consumer slot a module fills when it locks) remains valid as
> implementation guidance — but it is **not** a manifest mutation and is not a coding
> prerequisite gated on the manifest. This banner resolves the T-29.01-vs-ADR-0005 conflict
> flagged in the 2026-06-14 architecture-readiness audit.

This addendum delivers the pre-merge work the M29 spec flags as a prerequisite for the manifest patch: forward-seam deny-stubs in every module that will eventually consume M29-published seams but is not yet lock-grade. Without these stubs, the boot validator (§W-XI-15) would fail closed at startup because consuming modules reference seams whose names are published in `M29.publishedSeams` but whose consumer slots are empty.

The addendum covers **five forward-stub modules** (M30, M33, M34, M35, M37) and **ten consumer-seam pairs**. The pattern matches M28 D14 (`forward-stub` phase marker) verbatim.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- Manifest patch additions for M30, M33, M34, M35, M37 to add `29` to their `dependsOn` arrays and declare `phase: 'forward-stub'`.
- Ten TypeScript stub files, one per `(consuming module, M29 seam)` pair.
- Boot registration scaffolding for each forward-stub module's seam-consumer slot.
- Dependency-cruiser allowance (existing rule already permits dependsOn edges to satisfy the import graph — no new rule needed).
- Sign-off checklist binding to the same T-29.01 PR.

### 1.2 Non-goals

- **Real implementations.** Every stub throws `NotImplementedError`. The implementing module (M30, M33, …) is responsible for replacing its stub when that module reaches lock-grade.
- **M14, M19, M28, M40 updates.** Per the audit of locked specs (none reference M29 forward seams except M28, which is wired with a real consumer in §13.6 of the M28 spec). M40's NPPES consumption is already wired in M40 v0.2 (outbox event consumption, not seam read).
- **Patient/portal scope (M31).** M31 does not consume M29 seams in either phase per the architecture; no stub needed.
- **AI Platform (M32).** M32 does not consume M29 seams; M29 consumes a future M32 seam (`ProbabilisticMatchProvider`) in Phase 2, not the reverse.

---

## 2. Forward-Stub Module ↔ M29 Seam Matrix

| Consuming module | M29 seam consumed | Eventual use |
|---|---|---|
| **M30 HQRP & Quality** | `LabObservationProvider` | HQRP HOPE measure data may incorporate lab observation timing; HQRP submission audits cross-reference lab events. |
| **M33 Reporting & Dashboards** | `LabObservationProvider` | Lab activity dashboards. |
| **M33 Reporting & Dashboards** | `Hl7InboundProposalReader` | Proposal queue depth + decision-latency reporting. |
| **M33 Reporting & Dashboards** | `ExternalFeedReader` | Feed inventory and per-feed throughput dashboards. |
| **M33 Reporting & Dashboards** | `NppesProviderReader` | Prescriber-resolution reporting cross-cuts M33 dashboards. |
| **M33 Reporting & Dashboards** | `ExternalInterfaceMetricsProvider` | Cross-feed metrics on the platform reporting surface. |
| **M34 SaaS Tenant Platform** | `ExternalFeedReader` | Tenant admin console — feed health tiles, per-tenant inventory. |
| **M34 SaaS Tenant Platform** | `ExternalInterfaceMetricsProvider` | Per-tenant external-interfaces metrics on the SaaS console. |
| **M35 Subscription Billing** | `ExternalInterfaceMetricsProvider` | Phase 2 metering — per-feed or per-message billable consumption. |
| **M37 Inpatient Unit (IPU)** | `ExternalFeedReader` | IPU rosters filtered by partner-facility ID resolved from external feed config. |

Ten stubs total.

---

## 3. Manifest Patch Addendum — ⚠️ SUPERSEDED by ADR-0005 (do not apply)

> **Withdrawn.** Per ADR-0005 D1, deny-stub seam consumers take **no `dependsOn` edge**. The
> diff below is retained for historical context only; the live manifest correctly carries no
> `29` edges and no `phase` field. See the superseded banner at the top of this document.

This adds `29` to the `dependsOn` of M30, M33, M34, M35, M37 and tags each as `forward-stub` (so the boot validator knows to look for `NotImplementedError`-throwing stubs instead of real implementations).

### 3.1 Diff against `module-manifest.ts`

```diff
   { id: 30, name: "HQRP & Quality",
-    codePaths: ["apps/backend/src/modules/30-quality"], dependsOn: [10, 23, 27, 36, 38], ownedTables: [] },
+    codePaths: ["apps/backend/src/modules/30-quality"], dependsOn: [10, 23, 27, 29, 36, 38], ownedTables: [],
+    forwardStubSeams: ['LabObservationProvider'] },
   { id: 31, name: "Patient/Family Portal & Telehealth",
     codePaths: ["packages/telehealth-client", "apps/portal", "apps/backend/src/modules/31-portal"],
     dependsOn: [5, 7, 8, 22, 36, 39], ownedTables: [] },
   { id: 32, name: "AI Platform",
     codePaths: ["packages/ai-platform", "apps/backend/src/modules/32-ai-platform"],
     dependsOn: [1, 2, 3, 4], ownedTables: [] },
   { id: 33, name: "Reporting & Dashboards",
     codePaths: ["apps/backend/src/modules/33-reporting"],
-    dependsOn: [5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,30,38,40], ownedTables: [] },
+    dependsOn: [5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,29,30,38,40], ownedTables: [],
+    forwardStubSeams: [
+      'LabObservationProvider',
+      'Hl7InboundProposalReader',
+      'ExternalFeedReader',
+      'NppesProviderReader',
+      'ExternalInterfaceMetricsProvider',
+    ] },
   { id: 34, name: "SaaS Tenant Platform",
-    codePaths: ["packages/saas", "apps/admin", "apps/backend/src/modules/34-saas"], dependsOn: [2, 3, 4, 36], ownedTables: [] },
+    codePaths: ["packages/saas", "apps/admin", "apps/backend/src/modules/34-saas"],
+    dependsOn: [2, 3, 4, 29, 36], ownedTables: [],
+    forwardStubSeams: ['ExternalFeedReader', 'ExternalInterfaceMetricsProvider'] },
   { id: 35, name: "Subscription Billing",
-    codePaths: ["apps/backend/src/modules/35-subscription"], dependsOn: [34], ownedTables: [] },
+    codePaths: ["apps/backend/src/modules/35-subscription"], dependsOn: [29, 34], ownedTables: [],
+    forwardStubSeams: ['ExternalInterfaceMetricsProvider'] },
   { id: 37, name: "Inpatient Unit (IPU) Management",
-    codePaths: ["apps/backend/src/modules/37-ipu"], dependsOn: [6, 8, 11, 13, 17, 23], ownedTables: [] },
+    codePaths: ["apps/backend/src/modules/37-ipu"], dependsOn: [6, 8, 11, 13, 17, 23, 29], ownedTables: [],
+    forwardStubSeams: ['ExternalFeedReader'] },
```

### 3.2 Manifest type extension

Append to the `ModuleManifestEntry` type (top of `module-manifest.ts`):

```ts
export interface ModuleManifestEntry {
  id: number;
  name: string;
  codePaths: string[];
  dependsOn: number[];
  ownedTables: string[];
  /**
   * Seam names this module declares as forward-consumed but for which it ships
   * deny-stubs (NotImplementedError throwers) instead of real implementations.
   * The boot validator permits these to pass the "every consumed seam has a
   * registration" check while the module remains pre-lock-grade.
   */
  forwardStubSeams?: string[];
}
```

The boot validator update is in §6.

---

## 4. Stub File Inventory

All ten stubs live under `apps/backend/src/modules/<NN>-<key>/seam-stubs/<seam-name>.ts`. Each file is self-contained: imports the seam interface from M29, exports a single object whose every method throws `NotImplementedError` with a forward-stub marker string.

### 4.1 M30 — `LabObservationProvider`

**File:** `apps/backend/src/modules/30-quality/seam-stubs/lab-observation-provider.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  LabObservationProvider,
  LabObservationQuery,
  LabObservation,
  AbnormalLabQuery,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm30.forward-stub:LabObservationProvider';

export const m30LabObservationConsumerStub: LabObservationProvider = {
  async listByPatient(_query: LabObservationQuery): Promise<readonly LabObservation[]> {
    throw new NotImplementedError(
      `${STUB_MARKER}.listByPatient — M30 (HQRP) is not yet lock-grade; ` +
      `LabObservationProvider will be wired when HOPE measure cross-reference work lands.`,
    );
  },

  async listAbnormalForCaseload(_query: AbnormalLabQuery): Promise<readonly LabObservation[]> {
    throw new NotImplementedError(
      `${STUB_MARKER}.listAbnormalForCaseload — M30 (HQRP) is not yet lock-grade.`,
    );
  },

  async getById(_id: string): Promise<LabObservation | null> {
    throw new NotImplementedError(
      `${STUB_MARKER}.getById — M30 (HQRP) is not yet lock-grade.`,
    );
  },
};
```

### 4.2 M33 — Five M29 seams (broad reporting reader)

**File:** `apps/backend/src/modules/33-reporting/seam-stubs/lab-observation-provider.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  LabObservationProvider,
  LabObservationQuery,
  LabObservation,
  AbnormalLabQuery,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm33.forward-stub:LabObservationProvider';

export const m33LabObservationConsumerStub: LabObservationProvider = {
  async listByPatient(_query: LabObservationQuery): Promise<readonly LabObservation[]> {
    throw new NotImplementedError(`${STUB_MARKER}.listByPatient — M33 (Reporting) is not yet lock-grade.`);
  },
  async listAbnormalForCaseload(_query: AbnormalLabQuery): Promise<readonly LabObservation[]> {
    throw new NotImplementedError(`${STUB_MARKER}.listAbnormalForCaseload — M33 (Reporting) is not yet lock-grade.`);
  },
  async getById(_id: string): Promise<LabObservation | null> {
    throw new NotImplementedError(`${STUB_MARKER}.getById — M33 (Reporting) is not yet lock-grade.`);
  },
};
```

**File:** `apps/backend/src/modules/33-reporting/seam-stubs/hl7-inbound-proposal-reader.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  Hl7InboundProposalReader,
  ProposalQuery,
  ProposalSummary,
  ProposalAggregateQuery,
  ProposalAggregateResult,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm33.forward-stub:Hl7InboundProposalReader';

export const m33Hl7InboundProposalReaderStub: Hl7InboundProposalReader = {
  async list(_query: ProposalQuery): Promise<readonly ProposalSummary[]> {
    throw new NotImplementedError(`${STUB_MARKER}.list — M33 (Reporting) is not yet lock-grade.`);
  },
  async getById(_id: string): Promise<ProposalSummary | null> {
    throw new NotImplementedError(`${STUB_MARKER}.getById — M33 (Reporting) is not yet lock-grade.`);
  },
  async aggregate(_query: ProposalAggregateQuery): Promise<ProposalAggregateResult> {
    throw new NotImplementedError(`${STUB_MARKER}.aggregate — M33 (Reporting) is not yet lock-grade.`);
  },
};
```

**File:** `apps/backend/src/modules/33-reporting/seam-stubs/external-feed-reader.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  ExternalFeedReader,
  ExternalFeedQuery,
  ExternalFeedSummary,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm33.forward-stub:ExternalFeedReader';

export const m33ExternalFeedReaderStub: ExternalFeedReader = {
  async list(_query: ExternalFeedQuery): Promise<readonly ExternalFeedSummary[]> {
    throw new NotImplementedError(`${STUB_MARKER}.list — M33 (Reporting) is not yet lock-grade.`);
  },
  async getById(_id: string): Promise<ExternalFeedSummary | null> {
    throw new NotImplementedError(`${STUB_MARKER}.getById — M33 (Reporting) is not yet lock-grade.`);
  },
  async getHealthByFeed(_id: string): Promise<unknown> {
    throw new NotImplementedError(`${STUB_MARKER}.getHealthByFeed — M33 (Reporting) is not yet lock-grade.`);
  },
};
```

**File:** `apps/backend/src/modules/33-reporting/seam-stubs/nppes-provider-reader.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  NppesProviderReader,
  NppesProvider,
  NppesProviderQuery,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm33.forward-stub:NppesProviderReader';

export const m33NppesProviderReaderStub: NppesProviderReader = {
  async getByNpi(_npi: string): Promise<NppesProvider | null> {
    throw new NotImplementedError(`${STUB_MARKER}.getByNpi — M33 (Reporting) is not yet lock-grade.`);
  },
  async listByNpis(_npis: readonly string[]): Promise<readonly NppesProvider[]> {
    throw new NotImplementedError(`${STUB_MARKER}.listByNpis — M33 (Reporting) is not yet lock-grade.`);
  },
  async search(_query: NppesProviderQuery): Promise<readonly NppesProvider[]> {
    throw new NotImplementedError(`${STUB_MARKER}.search — M33 (Reporting) is not yet lock-grade.`);
  },
};
```

**File:** `apps/backend/src/modules/33-reporting/seam-stubs/external-interface-metrics-provider.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  ExternalInterfaceMetricsProvider,
  MetricsWindowQuery,
  FeedMetricsSnapshot,
  TenantMetricsSnapshot,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm33.forward-stub:ExternalInterfaceMetricsProvider';

export const m33ExternalInterfaceMetricsProviderStub: ExternalInterfaceMetricsProvider = {
  async snapshotByFeed(_feedId: string, _window: MetricsWindowQuery): Promise<FeedMetricsSnapshot> {
    throw new NotImplementedError(`${STUB_MARKER}.snapshotByFeed — M33 (Reporting) is not yet lock-grade.`);
  },
  async snapshotByTenant(_organizationId: string, _window: MetricsWindowQuery): Promise<TenantMetricsSnapshot> {
    throw new NotImplementedError(`${STUB_MARKER}.snapshotByTenant — M33 (Reporting) is not yet lock-grade.`);
  },
};
```

### 4.3 M34 — `ExternalFeedReader` + `ExternalInterfaceMetricsProvider`

**File:** `apps/backend/src/modules/34-saas/seam-stubs/external-feed-reader.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  ExternalFeedReader,
  ExternalFeedQuery,
  ExternalFeedSummary,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm34.forward-stub:ExternalFeedReader';

export const m34ExternalFeedReaderStub: ExternalFeedReader = {
  async list(_query: ExternalFeedQuery): Promise<readonly ExternalFeedSummary[]> {
    throw new NotImplementedError(
      `${STUB_MARKER}.list — M34 (SaaS Tenant Platform) is not yet lock-grade; ` +
      `the dashboard surface temporarily renders the placeholder feed-health tile from M29 §5.1.`,
    );
  },
  async getById(_id: string): Promise<ExternalFeedSummary | null> {
    throw new NotImplementedError(`${STUB_MARKER}.getById — M34 is not yet lock-grade.`);
  },
  async getHealthByFeed(_id: string): Promise<unknown> {
    throw new NotImplementedError(`${STUB_MARKER}.getHealthByFeed — M34 is not yet lock-grade.`);
  },
};
```

**File:** `apps/backend/src/modules/34-saas/seam-stubs/external-interface-metrics-provider.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  ExternalInterfaceMetricsProvider,
  MetricsWindowQuery,
  FeedMetricsSnapshot,
  TenantMetricsSnapshot,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm34.forward-stub:ExternalInterfaceMetricsProvider';

export const m34ExternalInterfaceMetricsProviderStub: ExternalInterfaceMetricsProvider = {
  async snapshotByFeed(_feedId: string, _window: MetricsWindowQuery): Promise<FeedMetricsSnapshot> {
    throw new NotImplementedError(`${STUB_MARKER}.snapshotByFeed — M34 (SaaS Tenant Platform) is not yet lock-grade.`);
  },
  async snapshotByTenant(_organizationId: string, _window: MetricsWindowQuery): Promise<TenantMetricsSnapshot> {
    throw new NotImplementedError(`${STUB_MARKER}.snapshotByTenant — M34 (SaaS Tenant Platform) is not yet lock-grade.`);
  },
};
```

### 4.4 M35 — `ExternalInterfaceMetricsProvider`

**File:** `apps/backend/src/modules/35-subscription/seam-stubs/external-interface-metrics-provider.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  ExternalInterfaceMetricsProvider,
  MetricsWindowQuery,
  FeedMetricsSnapshot,
  TenantMetricsSnapshot,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm35.forward-stub:ExternalInterfaceMetricsProvider';

export const m35ExternalInterfaceMetricsProviderStub: ExternalInterfaceMetricsProvider = {
  async snapshotByFeed(_feedId: string, _window: MetricsWindowQuery): Promise<FeedMetricsSnapshot> {
    throw new NotImplementedError(
      `${STUB_MARKER}.snapshotByFeed — M35 (Subscription Billing) is Phase 2; ` +
      `per-feed metering will land when the metering surface is lock-grade.`,
    );
  },
  async snapshotByTenant(_organizationId: string, _window: MetricsWindowQuery): Promise<TenantMetricsSnapshot> {
    throw new NotImplementedError(
      `${STUB_MARKER}.snapshotByTenant — M35 (Subscription Billing) is Phase 2.`,
    );
  },
};
```

### 4.5 M37 — `ExternalFeedReader`

**File:** `apps/backend/src/modules/37-ipu/seam-stubs/external-feed-reader.ts`

```ts
import { NotImplementedError } from '../../../core/errors';
import type {
  ExternalFeedReader,
  ExternalFeedQuery,
  ExternalFeedSummary,
} from '../../29-external-interfaces/seams/types';

const STUB_MARKER = 'm37.forward-stub:ExternalFeedReader';

export const m37ExternalFeedReaderStub: ExternalFeedReader = {
  async list(_query: ExternalFeedQuery): Promise<readonly ExternalFeedSummary[]> {
    throw new NotImplementedError(
      `${STUB_MARKER}.list — M37 (IPU Management) is not yet lock-grade; ` +
      `partner-facility filter wiring will land when M37 reaches lock-grade.`,
    );
  },
  async getById(_id: string): Promise<ExternalFeedSummary | null> {
    throw new NotImplementedError(`${STUB_MARKER}.getById — M37 (IPU Management) is not yet lock-grade.`);
  },
  async getHealthByFeed(_id: string): Promise<unknown> {
    throw new NotImplementedError(`${STUB_MARKER}.getHealthByFeed — M37 (IPU Management) is not yet lock-grade.`);
  },
};
```

---

## 5. Seam Consumer Registration (Per Module)

Each forward-stub module ships a `seam-stubs/register.ts` that the boot sequence calls. This binds the stub to the seam registry's `consumer` slot for that module — distinct from M29's `publisher` slot for the same seam.

### 5.1 M30

**File:** `apps/backend/src/modules/30-quality/seam-stubs/register.ts`

```ts
import type { SeamRegistry } from '../../../core/seams';
import { m30LabObservationConsumerStub } from './lab-observation-provider';

export function registerM30ForwardStubSeams(registry: SeamRegistry): void {
  registry.registerConsumer({
    moduleId: 30,
    seamName: 'LabObservationProvider',
    phase: 'forward-stub',
    impl: m30LabObservationConsumerStub,
  });
}
```

### 5.2 M33

**File:** `apps/backend/src/modules/33-reporting/seam-stubs/register.ts`

```ts
import type { SeamRegistry } from '../../../core/seams';
import { m33LabObservationConsumerStub } from './lab-observation-provider';
import { m33Hl7InboundProposalReaderStub } from './hl7-inbound-proposal-reader';
import { m33ExternalFeedReaderStub } from './external-feed-reader';
import { m33NppesProviderReaderStub } from './nppes-provider-reader';
import { m33ExternalInterfaceMetricsProviderStub } from './external-interface-metrics-provider';

export function registerM33ForwardStubSeams(registry: SeamRegistry): void {
  const phase = 'forward-stub' as const;
  registry.registerConsumer({ moduleId: 33, seamName: 'LabObservationProvider',           phase, impl: m33LabObservationConsumerStub });
  registry.registerConsumer({ moduleId: 33, seamName: 'Hl7InboundProposalReader',         phase, impl: m33Hl7InboundProposalReaderStub });
  registry.registerConsumer({ moduleId: 33, seamName: 'ExternalFeedReader',               phase, impl: m33ExternalFeedReaderStub });
  registry.registerConsumer({ moduleId: 33, seamName: 'NppesProviderReader',              phase, impl: m33NppesProviderReaderStub });
  registry.registerConsumer({ moduleId: 33, seamName: 'ExternalInterfaceMetricsProvider', phase, impl: m33ExternalInterfaceMetricsProviderStub });
}
```

### 5.3 M34

**File:** `apps/backend/src/modules/34-saas/seam-stubs/register.ts`

```ts
import type { SeamRegistry } from '../../../core/seams';
import { m34ExternalFeedReaderStub } from './external-feed-reader';
import { m34ExternalInterfaceMetricsProviderStub } from './external-interface-metrics-provider';

export function registerM34ForwardStubSeams(registry: SeamRegistry): void {
  const phase = 'forward-stub' as const;
  registry.registerConsumer({ moduleId: 34, seamName: 'ExternalFeedReader',               phase, impl: m34ExternalFeedReaderStub });
  registry.registerConsumer({ moduleId: 34, seamName: 'ExternalInterfaceMetricsProvider', phase, impl: m34ExternalInterfaceMetricsProviderStub });
}
```

### 5.4 M35

**File:** `apps/backend/src/modules/35-subscription/seam-stubs/register.ts`

```ts
import type { SeamRegistry } from '../../../core/seams';
import { m35ExternalInterfaceMetricsProviderStub } from './external-interface-metrics-provider';

export function registerM35ForwardStubSeams(registry: SeamRegistry): void {
  registry.registerConsumer({
    moduleId: 35,
    seamName: 'ExternalInterfaceMetricsProvider',
    phase: 'forward-stub',
    impl: m35ExternalInterfaceMetricsProviderStub,
  });
}
```

### 5.5 M37

**File:** `apps/backend/src/modules/37-ipu/seam-stubs/register.ts`

```ts
import type { SeamRegistry } from '../../../core/seams';
import { m37ExternalFeedReaderStub } from './external-feed-reader';

export function registerM37ForwardStubSeams(registry: SeamRegistry): void {
  registry.registerConsumer({
    moduleId: 37,
    seamName: 'ExternalFeedReader',
    phase: 'forward-stub',
    impl: m37ExternalFeedReaderStub,
  });
}
```

---

## 6. Boot Validator Update

The boot validator in `boot.ts` already enforces "every seam name a module declares as consumed must be registered before boot completes". The forward-stub variant relaxes that for `phase: 'forward-stub'` registrations: they pass the registration check but a separate startup log warns about each one.

### 6.1 `boot.ts` Additions

```ts
// apps/backend/src/boot.ts (additions)

import { registerM30ForwardStubSeams } from './modules/30-quality/seam-stubs/register';
import { registerM33ForwardStubSeams } from './modules/33-reporting/seam-stubs/register';
import { registerM34ForwardStubSeams } from './modules/34-saas/seam-stubs/register';
import { registerM35ForwardStubSeams } from './modules/35-subscription/seam-stubs/register';
import { registerM37ForwardStubSeams } from './modules/37-ipu/seam-stubs/register';

export async function boot(deps: BootDeps): Promise<void> {
  // ... existing M1..M28 registrations ...
  // ... M29 registrations from M29 spec §13.3 ...

  // M29 forward-stub consumers — these MUST land after M29's publisher registration
  // so the registry sees the publisher slot filled before the consumer slot is bound.
  registerM30ForwardStubSeams(deps.seamRegistry);
  registerM33ForwardStubSeams(deps.seamRegistry);
  registerM34ForwardStubSeams(deps.seamRegistry);
  registerM35ForwardStubSeams(deps.seamRegistry);
  registerM37ForwardStubSeams(deps.seamRegistry);

  // ... existing M38..M40 registrations ...

  // After every module has registered, validate the registry.
  const validation = deps.seamRegistry.validate();
  if (!validation.ok) {
    throw new BootValidationError(validation.errors);
  }

  // Forward-stub registrations emit a single info log per stub at startup.
  for (const stub of deps.seamRegistry.allForwardStubs()) {
    deps.logger.info(
      { moduleId: stub.moduleId, seamName: stub.seamName },
      'boot.seam.forward_stub_registered',
    );
  }
}
```

### 6.2 `SeamRegistry` API additions

```ts
// apps/backend/src/core/seams.ts (additions to the existing SeamRegistry type)

export interface SeamConsumerRegistration<T> {
  moduleId: number;
  seamName: string;
  phase: 'live' | 'forward-stub';
  impl: T;
}

export interface SeamValidationError {
  kind: 'no_publisher' | 'no_consumer' | 'unknown_seam';
  moduleId?: number;
  seamName: string;
  message: string;
}

export interface SeamValidationResult {
  ok: boolean;
  errors: readonly SeamValidationError[];
}

export interface SeamRegistry {
  // ... existing publish() ...

  registerConsumer<T>(registration: SeamConsumerRegistration<T>): void;

  /** Returns all consumers in 'forward-stub' phase, for boot-time info logging. */
  allForwardStubs(): readonly { moduleId: number; seamName: string }[];

  /**
   * Validates every consumed seam has a registered publisher.
   * forward-stub consumers count as registered consumers — they do NOT
   * relax the publisher-must-exist requirement.
   */
  validate(): SeamValidationResult;
}
```

### 6.3 `check:manifest` script update

The existing `check-table-ownership.ts` script and the manifest-consistency check learn the `forwardStubSeams` field. The pseudo-code addition:

```ts
// scripts/check-manifest.ts (additions)

for (const mod of MODULES) {
  for (const seamName of mod.forwardStubSeams ?? []) {
    // Each declared forward-stub seam must:
    // (a) be a name published by some other module (resolved against the global publishedSeams set)
    // (b) have a registered file at apps/backend/src/modules/<NN>-<key>/seam-stubs/<kebab-name>.ts
    // (c) be re-exported by apps/backend/src/modules/<NN>-<key>/seam-stubs/register.ts
    assertSeamIsPublished(seamName);
    assertStubFileExists(mod, seamName);
    assertStubRegistered(mod, seamName);
  }
}
```

CI fails on any drift (declared seam without stub, or stub without declaration). This closes the lock-grade loop: a future developer cannot silently delete a stub without the manifest declaration also being updated.

---

## 7. Test Plan

### 7.1 Per-Stub Throw Test

Each stub file ships a co-located test verifying every method throws `NotImplementedError` with the expected `STUB_MARKER` substring.

```ts
// apps/backend/src/modules/30-quality/seam-stubs/lab-observation-provider.test.ts

import { describe, it, expect } from 'vitest';
import { NotImplementedError } from '../../../core/errors';
import { m30LabObservationConsumerStub } from './lab-observation-provider';

describe('m30LabObservationConsumerStub', () => {
  it('listByPatient throws NotImplementedError with forward-stub marker', async () => {
    await expect(m30LabObservationConsumerStub.listByPatient({} as never))
      .rejects.toThrow(NotImplementedError);
    await expect(m30LabObservationConsumerStub.listByPatient({} as never))
      .rejects.toThrow(/m30\.forward-stub:LabObservationProvider/);
  });

  it('listAbnormalForCaseload throws NotImplementedError with forward-stub marker', async () => {
    await expect(m30LabObservationConsumerStub.listAbnormalForCaseload({} as never))
      .rejects.toThrow(/m30\.forward-stub:LabObservationProvider/);
  });

  it('getById throws NotImplementedError with forward-stub marker', async () => {
    await expect(m30LabObservationConsumerStub.getById('any-id'))
      .rejects.toThrow(/m30\.forward-stub:LabObservationProvider/);
  });
});
```

A test like this lives next to every stub file (ten total). Each is ~20 lines, copy-pattern.

### 7.2 Boot-Validator Acceptance Test

```ts
// test/integration/boot/forward_stubs.test.ts

import { describe, it, expect } from 'vitest';
import { boot } from '../../../apps/backend/src/boot';
import { mkBootDepsFixture } from './fixtures';

describe('Boot — M29 forward-stub registrations', () => {
  it('boots successfully with all five forward-stub modules registered', async () => {
    const deps = mkBootDepsFixture();
    await expect(boot(deps)).resolves.toBeUndefined();

    const stubs = deps.seamRegistry.allForwardStubs();
    expect(stubs).toHaveLength(10);
    expect(stubs.map(s => `${s.moduleId}:${s.seamName}`).sort()).toEqual([
      '30:LabObservationProvider',
      '33:ExternalFeedReader',
      '33:ExternalInterfaceMetricsProvider',
      '33:Hl7InboundProposalReader',
      '33:LabObservationProvider',
      '33:NppesProviderReader',
      '34:ExternalFeedReader',
      '34:ExternalInterfaceMetricsProvider',
      '35:ExternalInterfaceMetricsProvider',
      '37:ExternalFeedReader',
    ]);
  });

  it('boot fails closed if a manifest-declared forward-stub seam has no stub file', async () => {
    const deps = mkBootDepsFixture({ omitStub: { moduleId: 37, seamName: 'ExternalFeedReader' } });
    await expect(boot(deps)).rejects.toThrow(/no_consumer/);
  });

  it('boot fails closed if a stub is registered for an unpublished seam name', async () => {
    const deps = mkBootDepsFixture({
      extraStub: { moduleId: 33, seamName: 'NotARealSeamProvider', impl: { fake: () => {} } },
    });
    await expect(boot(deps)).rejects.toThrow(/unknown_seam/);
  });

  it('every forward-stub registration generates a single info log entry', async () => {
    const deps = mkBootDepsFixture();
    await boot(deps);
    const stubLogs = deps.logger.captured.filter(l => l.msg === 'boot.seam.forward_stub_registered');
    expect(stubLogs).toHaveLength(10);
  });
});
```

### 7.3 Dependency-Cruiser Verification

Run `bun run check:cruiser` against the post-merge tree:

- M29 → M30 / M33 / M34 / M35 / M37: no edges (M29 does not import the forward-stub modules).
- M30 / M33 / M34 / M35 / M37 → M29: imports limited to `apps/backend/src/modules/29-external-interfaces/seams/types` (the seam interface types). No direct schema imports, no service imports, no runtime impl imports.

A dedicated cruiser rule guards this:

```js
{
  name: 'forward-stub-import-types-only',
  comment: 'Forward-stub modules may import only seam type definitions from M29, never runtime impls.',
  severity: 'error',
  from: { path: '^apps/backend/src/modules/(30|33|34|35|37)-[a-z-]+/seam-stubs' },
  to: {
    path: '^apps/backend/src/modules/29-external-interfaces',
    pathNot: '^apps/backend/src/modules/29-external-interfaces/seams/types(\\.ts)?$',
  },
},
```

---

## 8. Sign-Off Checklist (Folds Into T-29.01 PR)

- [ ] Manifest patch (§3) applied; `ModuleManifestEntry.forwardStubSeams` type added.
- [ ] All ten stub files (§4) land under their respective `seam-stubs/` directories.
- [ ] Five `register.ts` files (§5) land alongside.
- [ ] `boot.ts` calls each `registerM{NN}ForwardStubSeams` in dependency order (§6.1).
- [ ] `SeamRegistry.registerConsumer`, `.allForwardStubs`, `.validate` API additions land in `core/seams.ts` (§6.2).
- [ ] `check:manifest` learns `forwardStubSeams` validation (§6.3).
- [ ] Ten per-stub throw tests pass (§7.1).
- [ ] Boot-validator integration tests pass (§7.2 — four scenarios).
- [ ] `check:cruiser` passes with the new forward-stub-types-only rule (§7.3).
- [ ] Architecture lead sign-off on the M30/M33/M34/M35/M37 dependsOn additions (the `29` edge specifically).

---

## 9. Replacement Discipline

When any of M30, M33, M34, M35, M37 reaches lock-grade in its own spec, the per-module spec MUST include in its acceptance sign-off:

1. **Replace the stub file** with a real implementation. The file path stays the same; the export name stays the same; only the body changes.
2. **Update `register.ts`** to change `phase: 'forward-stub'` to `phase: 'live'`. (Compile-time guard via TypeScript's discriminated union — the dual-phase shape is intentional.)
3. **Update `module-manifest.ts`** to remove the seam name from `forwardStubSeams`. The dependsOn edge stays.
4. **Add live integration tests** that exercise the real M29 seam call from the consuming module.
5. **Boot-validator log expectation** in §7.2 drops by one (10 → 9 → 8 → ...).
6. **Audit chain:** the lock-grade spec for that module records the removal in its Changelog.

This discipline is the inverse of the stub-creation discipline above. Without it, the platform could end up with phantom forward-stubs that never get replaced because nobody noticed.

---

## Document Footer

**Addendum version:** v1.0 (T-29.01 PR-ready)
**Bound to:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §13.7
**Stub files delivered:** 10
**Modules touched:** M30, M33, M34, M35, M37 (+ manifest + boot.ts + core/seams.ts)
**Tests delivered:** 10 per-stub + 4 boot-validator integration scenarios
**dependsOn additions:** `29` to five modules

**End of T-29.01 forward-seam deny-stub addendum.**
