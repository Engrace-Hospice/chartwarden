# WardenX — T-29.12 / T-29.13 Combined Addendum: M29 Frontend

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §5 (UI Surfaces), §10 (T-29.12, T-29.13)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 → T-29.11 merged. The backend APIs T-29.12/13 consume are stable at v0.3 + the small additions from T-29.08/10/11.

This addendum delivers the M29 frontend surfaces in one consolidated PR pair. T-29.12 ships the **administrative surfaces** (feed admin, credential rotation, NPPES admin); T-29.13 ships the **clinical-operational surfaces** (proposal inbox/review, unmatched-lab queue, privileged SUD unredact). They share infrastructure — auth-gated route shells, TanStack Query hooks for the M29 REST surface, Socket.IO room subscriptions for realtime queue updates, and a small library of M29-specific UI primitives — so they're bundled.

T-29.12 and T-29.13 each ship as their own PR per the platform release discipline; the deliverables below are organized accordingly.

---

## 1. Scope & Non-Goals

### 1.1 In scope — T-29.12 (Administrative)

- **Feed admin surface** — `/app/external-interfaces/feeds`
  - Feed list + filter by kind/status
  - Feed detail (health metrics, recent messages, credentials, partners)
  - Feed create / edit / suspend / activate (compliance co-approval workflow)
- **Credential rotation surface** — `/app/external-interfaces/feeds/:feedId/credentials`
  - Active credential card with expiration countdown
  - Rotation request → approve (different membership) → execute (T-29.10 workflow)
  - Rotation history
- **NPPES admin surface** — `/app/external-interfaces/nppes`
  - Sync run list + drill-down
  - Manual sync trigger (step-up + permission)
  - Cached provider lookup by NPI

### 1.2 In scope — T-29.13 (Clinical Operational)

- **Inbound proposal inbox** — `/app/external-interfaces/inbound-proposals`
  - Queue list filtered by owner_module (m5 / m6), proposal_status, match_outcome
  - Per-proposal card: source message + match-cascade summary + proposed-fields diff
  - Accept (full or partial-field) / Reject / Discard with required decision rationale
- **Unmatched lab queue** — `/app/external-interfaces/unmatched-labs`
  - Queue list filtered by message age + SUD status
  - Per-lab card: observation summary, candidate patient (if any), values (redacted where applicable)
  - Bind (patient picker) / Discard
- **SUD privileged unredact** — `/app/external-interfaces/lab-observations/:id/sud-unredact-request`
  - Request grant with clinical rationale
  - View granted-but-unexercised grants and exercise them
  - Emergency-basis 42 CFR §2.51 path with explicit checkbox + extra confirmation

### 1.3 Out of scope (deferred to T-29.14)

- Operational dashboards (uptime SLO, ACK rate histograms, abnormal-flag heatmaps) — T-29.14.
- Per-tenant compliance reports — T-29.14.
- Audit-log search UI — M4-owned, future PR.

---

## 2. Tech Stack & Shared Infrastructure

Per architecture §15: TanStack Router + TanStack Query + TanStack Form, shadcn/ui primitives, Tailwind, Capacitor for mobile (mobile clients consume the same routes, but T-29.13's inbox is the only one optimized for mobile per use cases). Socket.IO consumed from the M36 client for realtime.

**Shared infra files (both PRs depend on these):**

```
apps/frontend/src/modules/29-external-interfaces/
├── _shared/
│   ├── api-client.ts                    # typed fetch wrappers for the M29 REST surface
│   ├── hooks/
│   │   ├── use-feeds.ts                 # list, byId, create, suspend, activate
│   │   ├── use-feed-credentials.ts
│   │   ├── use-credential-rotation.ts   # request, approve, execute, cancel
│   │   ├── use-proposals.ts             # inbox list, byId, accept, reject, discard
│   │   ├── use-unmatched-labs.ts        # list, bind, discard
│   │   ├── use-sud-unredact.ts          # request, approve, exercise
│   │   ├── use-nppes-sync.ts            # runs list, trigger, byId
│   │   ├── use-nppes-providers.ts       # byNpi
│   │   ├── use-realtime-inbox.ts        # Socket.IO subscription with invalidation
│   │   └── use-step-up.ts               # M2 step-up trigger + verification
│   ├── components/
│   │   ├── MessageControlIdBadge.tsx
│   │   ├── MatchLevelChip.tsx           # styled rendering of L1_MRN_EXACT etc
│   │   ├── ProposalStatusChip.tsx
│   │   ├── SudRedactionBadge.tsx        # status enum → user-readable badge
│   │   ├── PatientSummaryRow.tsx        # name + DOB + MRN, with redaction-aware fields
│   │   ├── FeedHealthIndicator.tsx      # green/yellow/red breaker visualization
│   │   ├── RationaleTextArea.tsx        # min-length-enforced, label-styled
│   │   ├── StepUpModal.tsx
│   │   └── EmptyState.tsx
│   ├── permissions.ts                   # permission key constants
│   └── routes.ts                        # routing table for both PRs
└── README.md
```

### 2.1 API client

```tsx
// apps/frontend/src/modules/29-external-interfaces/_shared/api-client.ts
import { z } from 'zod'

const BASE = '/api/v1/hl7'

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: any) {
    super(`api_error_${status}`)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown, schema?: z.ZodSchema<T>): Promise<T> {
  const response = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',  // cookies for M2 session
  })

  const isJson = response.headers.get('content-type')?.includes('application/json')
  const data = isJson ? await response.json() : null

  if (!response.ok) throw new ApiError(response.status, data)
  return schema ? schema.parse(data) : (data as T)
}

// Typed endpoints
export const m29Api = {
  // Feed admin
  listFeeds: (params: { kind?: string; status?: string }) =>
    request('GET', `/feeds?${new URLSearchParams(params as any)}`),
  getFeed: (id: string) => request('GET', `/feeds/${id}`),
  createFeed: (payload: CreateFeedPayload) => request('POST', '/feeds', payload),
  suspendFeed: (id: string, payload: { rationale: string }) => request('POST', `/feeds/${id}/suspend`, payload),

  // Credential rotation (T-29.10)
  requestRotation: (feedId: string, payload: { rationale: string }) =>
    request('POST', `/feeds/${feedId}/credentials/rotate/request`, payload),
  approveRotation: (rotationId: string, payload: { coApproverRationale: string }) =>
    request('POST', `/feeds/credentials/rotations/${rotationId}/approve`, payload),
  executeRotation: (rotationId: string) =>
    request('POST', `/feeds/credentials/rotations/${rotationId}/execute`),
  cancelRotation: (rotationId: string) =>
    request('POST', `/feeds/credentials/rotations/${rotationId}/cancel`),
  getRotation: (rotationId: string) => request('GET', `/feeds/credentials/rotations/${rotationId}`),

  // Proposals (T-29.06)
  listProposals: (params: { ownerModule?: 'm5' | 'm6'; proposalStatus?: string; limit?: number }) =>
    request('GET', `/inbound-proposals?${new URLSearchParams(params as any)}`),
  getProposal: (id: string) => request('GET', `/inbound-proposals/${id}`),
  acceptProposal: (id: string, payload: { appliedFields?: string[]; acceptedAggregateId?: string; decisionRationale?: string }) =>
    request('POST', `/inbound-proposals/${id}/accept`, payload),
  rejectProposal: (id: string, payload: { decisionRationale: string }) =>
    request('POST', `/inbound-proposals/${id}/reject`, payload),
  discardProposal: (id: string, payload: { decisionRationale: string }) =>
    request('POST', `/inbound-proposals/${id}/discard`, payload),

  // Unmatched labs (T-29.07)
  listUnmatchedLabs: () => request('GET', '/unmatched-labs'),
  bindLab: (id: string, payload: { patientId: string; decisionRationale: string }) =>
    request('POST', `/unmatched-labs/${id}/bind`, payload),
  discardLab: (id: string, payload: { decisionRationale: string }) =>
    request('POST', `/unmatched-labs/${id}/discard`, payload),

  // SUD unredact (T-29.11)
  requestSudUnredact: (observationId: string, payload: { clinicalRationale: string; emergencyBasis42cfr2_51?: boolean }) =>
    request('POST', `/lab-observations/${observationId}/request-unredact-grant`, payload),
  approveSudUnredact: (grantId: string, payload: { approverRationale: string }) =>
    request('POST', `/lab-observations/sud-unredact-grants/${grantId}/approve`, payload),
  exerciseSudUnredact: (grantId: string) =>
    request('POST', `/lab-observations/sud-unredact-grants/${grantId}/exercise`),

  // NPPES (T-29.09)
  triggerNppesSync: () => request('POST', '/nppes/sync/trigger'),
  listSyncRuns: (limit = 20) => request('GET', `/nppes/sync/runs?limit=${limit}`),
  getSyncRun: (id: string) => request('GET', `/nppes/sync/runs/${id}`),
  getProviderByNpi: (npi: string) => request('GET', `/nppes/providers/${npi}`),
}
```

### 2.2 TanStack Query hooks (representative — proposals)

```tsx
// apps/frontend/src/modules/29-external-interfaces/_shared/hooks/use-proposals.ts
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query'
import { m29Api } from '../api-client'

export const proposalQueries = {
  list: (params: { ownerModule?: 'm5' | 'm6'; proposalStatus?: string }) =>
    queryOptions({
      queryKey: ['m29', 'proposals', 'list', params] as const,
      queryFn: () => m29Api.listProposals(params),
      staleTime: 15_000,
    }),
  byId: (id: string) =>
    queryOptions({
      queryKey: ['m29', 'proposals', 'byId', id] as const,
      queryFn: () => m29Api.getProposal(id),
      staleTime: 5_000,
    }),
}

export function useProposals(params: { ownerModule?: 'm5' | 'm6'; proposalStatus?: string }) {
  return useQuery(proposalQueries.list(params))
}

export function useProposal(id: string) {
  return useQuery(proposalQueries.byId(id))
}

export function useAcceptProposal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => m29Api.acceptProposal(id, payload),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['m29', 'proposals'] })
      qc.invalidateQueries({ queryKey: ['m29', 'proposals', 'byId', id] })
    },
  })
}

export function useRejectProposal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { decisionRationale: string } }) => m29Api.rejectProposal(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['m29', 'proposals'] }),
  })
}

export function useDiscardProposal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { decisionRationale: string } }) => m29Api.discardProposal(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['m29', 'proposals'] }),
  })
}
```

### 2.3 Realtime invalidation

The M36 Socket.IO client publishes events on `org:<orgId>` rooms. M29 subscribes to relevant event names and invalidates cached queries.

```tsx
// apps/frontend/src/modules/29-external-interfaces/_shared/hooks/use-realtime-inbox.ts
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSocket } from '@wardenx/foundation/realtime'

const REFRESH_EVENTS = [
  'm29.hl7_inbound_proposal.created',
  'm29.hl7_inbound_proposal.accepted',
  'm29.hl7_inbound_proposal.rejected',
  'm29.hl7_inbound_proposal.discarded',
  'm29.hl7_inbound_proposal.expired',
  'm29.lab_observation.unmatched',
  'm29.lab_observation.bound',
  'm29.lab_observation.sud_status_changed',
  'm29.external_feed.listener_down',
  'm29.external_feed.listener_recovered',
]

export function useRealtimeInbox() {
  const qc = useQueryClient()
  const socket = useSocket()

  useEffect(() => {
    const handler = (event: { name: string }) => {
      // Bulk invalidation — the cached queries refresh via TanStack's auto-refetch
      if (event.name.startsWith('m29.hl7_inbound_proposal.')) {
        qc.invalidateQueries({ queryKey: ['m29', 'proposals'] })
      }
      if (event.name.startsWith('m29.lab_observation.')) {
        qc.invalidateQueries({ queryKey: ['m29', 'unmatched-labs'] })
      }
      if (event.name.startsWith('m29.external_feed.')) {
        qc.invalidateQueries({ queryKey: ['m29', 'feeds'] })
      }
    }

    for (const name of REFRESH_EVENTS) socket.on(name, handler)
    return () => {
      for (const name of REFRESH_EVENTS) socket.off(name, handler)
    }
  }, [socket, qc])
}
```

Mounted once at the M29 routes layout level so every M29 page benefits.

---

## 3. T-29.12 Deliverable A: Feed Admin

### 3.1 `FeedListPage.tsx`

```tsx
// apps/frontend/src/modules/29-external-interfaces/feed-admin/FeedListPage.tsx
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Link } from '@tanstack/react-router'
import { useFeeds } from '../_shared/hooks/use-feeds'
import { FeedHealthIndicator } from '../_shared/components/FeedHealthIndicator'
import { EmptyState } from '../_shared/components/EmptyState'

export function FeedListPage() {
  return (
    <div className="container max-w-6xl py-6">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">External Interfaces — Feeds</h1>
          <p className="text-sm text-muted-foreground mt-1">
            HL7 v2 inbound listeners and outbound dispatch endpoints. All feeds enforce mTLS 1.3 and per-feed credential pinning.
          </p>
        </div>
        <Button asChild>
          <Link to="/external-interfaces/feeds/new">+ New Feed</Link>
        </Button>
      </header>

      <Tabs defaultValue="inbound">
        <TabsList>
          <TabsTrigger value="inbound">Inbound (ADT + Labs)</TabsTrigger>
          <TabsTrigger value="outbound">Outbound (ORM)</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>

        <TabsContent value="inbound">
          <FeedTable kindFilter={['adt_inbound', 'lab_inbound']} />
        </TabsContent>
        <TabsContent value="outbound">
          <FeedTable kindFilter={['orm_outbound']} />
        </TabsContent>
        <TabsContent value="all">
          <FeedTable />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function FeedTable({ kindFilter }: { kindFilter?: string[] }) {
  const { data, isLoading, error } = useFeeds()
  if (isLoading) return <FeedTableSkeleton />
  if (error) return <ErrorBanner error={error} />
  if (!data || data.length === 0) return <EmptyState title="No feeds configured" body="Add a feed to begin receiving HL7 messages from a partner facility." />

  const filtered = kindFilter ? data.filter(f => kindFilter.includes(f.kind)) : data

  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full">
          <thead className="bg-muted/50 text-xs uppercase">
            <tr>
              <th className="text-left p-3">Display Name</th>
              <th className="text-left p-3">Kind</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Health</th>
              <th className="text-left p-3">Last Message</th>
              <th className="text-left p-3">Credential Expiry</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map(feed => (
              <tr key={feed.id} className="border-t hover:bg-muted/30">
                <td className="p-3 font-medium">
                  <Link to="/external-interfaces/feeds/$feedId" params={{ feedId: feed.id }} className="hover:underline">
                    {feed.displayName}
                  </Link>
                </td>
                <td className="p-3"><Badge variant="outline">{feed.kind}</Badge></td>
                <td className="p-3"><Badge variant={feed.status === 'active' ? 'default' : 'secondary'}>{feed.status}</Badge></td>
                <td className="p-3"><FeedHealthIndicator state={feed.healthState} /></td>
                <td className="p-3 text-sm text-muted-foreground">
                  {feed.lastMessageAt ? new Date(feed.lastMessageAt).toLocaleString() : '—'}
                </td>
                <td className="p-3 text-sm">
                  <CredentialExpiryBadge expiresAt={feed.activeCredentialExpiresAt} />
                </td>
                <td className="p-3">
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/external-interfaces/feeds/$feedId" params={{ feedId: feed.id }}>Open →</Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function CredentialExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span className="text-muted-foreground">no active cred</span>
  const daysOut = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000)
  if (daysOut < 0) return <Badge variant="destructive">expired {Math.abs(daysOut)}d ago</Badge>
  if (daysOut < 7) return <Badge variant="destructive">{daysOut}d</Badge>
  if (daysOut < 30) return <Badge variant="warning">{daysOut}d</Badge>
  return <Badge variant="outline">{daysOut}d</Badge>
}
```

### 3.2 `FeedDetailPage.tsx`

Shows feed configuration, recent message volume sparkline, the active credential, the rotation history, the partner-IP allowlist.

```tsx
// apps/frontend/src/modules/29-external-interfaces/feed-admin/FeedDetailPage.tsx
import { useParams } from '@tanstack/react-router'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useFeed } from '../_shared/hooks/use-feeds'
import { useRealtimeInbox } from '../_shared/hooks/use-realtime-inbox'
import { FeedHealthIndicator } from '../_shared/components/FeedHealthIndicator'
import { CredentialRotationCard } from './CredentialRotationCard'
import { RecentMessagesSparkline } from './RecentMessagesSparkline'
import { PartnerAllowlistEditor } from './PartnerAllowlistEditor'

export function FeedDetailPage() {
  useRealtimeInbox()
  const { feedId } = useParams({ strict: false }) as { feedId: string }
  const { data: feed, isLoading } = useFeed(feedId)
  if (isLoading) return <FeedDetailSkeleton />
  if (!feed) return <NotFound />

  return (
    <div className="container max-w-6xl py-6 space-y-6">
      <header>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{feed.displayName}</h1>
          <FeedHealthIndicator state={feed.healthState} size="lg" />
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {feed.kind} · Port {feed.port} · {feed.host}
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <KV label="Kind" value={feed.kind} />
            <KV label="Host" value={feed.host} />
            <KV label="Port" value={feed.port} />
            <KV label="Protocol" value={feed.protocol} mono />
            <KV label="Created" value={new Date(feed.createdAt).toLocaleString()} />
            <KV label="BAA Status" value={<BaaStatusBadge status={feed.baaStatus} />} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <RecentMessagesSparkline feedId={feed.id} />
          </CardContent>
        </Card>
      </div>

      <CredentialRotationCard feedId={feed.id} />

      <Card>
        <CardHeader>
          <CardTitle>Partner allowlist</CardTitle>
        </CardHeader>
        <CardContent>
          <PartnerAllowlistEditor feedId={feed.id} initialList={feed.sendingFacilityAllowlist} />
        </CardContent>
      </Card>
    </div>
  )
}
```

### 3.3 `CredentialRotationCard.tsx` (the dual-approval UI for T-29.10)

This is the most consequential T-29.12 component because it gates real PKI changes.

```tsx
// apps/frontend/src/modules/29-external-interfaces/feed-admin/CredentialRotationCard.tsx
import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useFeedActiveCredential, useFeedRotations } from '../_shared/hooks/use-feed-credentials'
import { useRequestRotation, useApproveRotation, useExecuteRotation } from '../_shared/hooks/use-credential-rotation'
import { useStepUp } from '../_shared/hooks/use-step-up'
import { RationaleTextArea } from '../_shared/components/RationaleTextArea'
import { useToast } from '@/components/ui/toast'
import { hasPermission, useCurrentUser } from '@wardenx/foundation/auth-client'

export function CredentialRotationCard({ feedId }: { feedId: string }) {
  const { data: activeCred } = useFeedActiveCredential(feedId)
  const { data: rotations } = useFeedRotations(feedId)
  const pendingRotation = rotations?.find(r => r.state === 'requested' || r.state === 'co_approved')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active credential</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {activeCred ? (
          <>
            <KV label="Fingerprint" value={<code className="text-xs">{activeCred.fingerprint}</code>} />
            <KV label="Issued" value={new Date(activeCred.createdAt).toLocaleString()} />
            <KV label="Expires" value={<CredentialExpiryBadge expiresAt={activeCred.expiresAt} />} />
          </>
        ) : (
          <p className="text-muted-foreground">No active credential.</p>
        )}
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-2">
        {pendingRotation ? (
          <PendingRotationPanel rotation={pendingRotation} feedId={feedId} />
        ) : (
          <RequestRotationDialog feedId={feedId} />
        )}
      </CardFooter>
    </Card>
  )
}

function RequestRotationDialog({ feedId }: { feedId: string }) {
  const [open, setOpen] = useState(false)
  const [rationale, setRationale] = useState('')
  const stepUp = useStepUp()
  const requestRotation = useRequestRotation()
  const { toast } = useToast()

  const user = useCurrentUser()
  const canRequest = hasPermission(user, 'external_interfaces.feed_credential:rotate')
  if (!canRequest) return null

  const submit = async () => {
    try {
      await stepUp.ensureRecent(300)
      await requestRotation.mutateAsync({ feedId, payload: { rationale } })
      setOpen(false)
      setRationale('')
      toast({ title: 'Rotation requested', description: 'Awaiting compliance co-approval (distinct membership required).' })
    } catch (err) {
      toast({ title: 'Rotation request failed', description: (err as Error).message, variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Rotate credential</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request credential rotation</DialogTitle>
          <DialogDescription>
            Rotating will provision a new credential and retire the existing one. The new credential will be enforced for both the inbound listener and any outbound dispatcher within ≤2 seconds of execute. A different membership must co-approve before you can execute. Step-up authentication is required.
          </DialogDescription>
        </DialogHeader>
        <RationaleTextArea
          label="Rationale"
          value={rationale}
          onChange={setRationale}
          minLength={10}
          placeholder="e.g. Quarterly rotation per security policy; previous rotation 90 days ago."
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={rationale.length < 10 || requestRotation.isPending}>
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PendingRotationPanel({ rotation, feedId }: { rotation: any; feedId: string }) {
  const user = useCurrentUser()
  const isRequester = rotation.requesterMembershipId === user.membershipId

  return (
    <div className="border rounded-md p-4 bg-amber-50/50">
      <div className="flex items-center justify-between mb-2">
        <Badge>{rotation.state}</Badge>
        <span className="text-xs text-muted-foreground">
          Requested {new Date(rotation.requestedAt).toLocaleString()} · expires {new Date(rotation.expiresAt).toLocaleString()}
        </span>
      </div>
      <p className="text-sm mb-3"><strong>Rationale:</strong> {rotation.rationale}</p>

      {rotation.state === 'requested' ? (
        isRequester ? (
          <p className="text-sm text-muted-foreground">Awaiting co-approval from a different membership. You cannot self-approve.</p>
        ) : (
          <CoApproveDialog rotation={rotation} />
        )
      ) : rotation.state === 'co_approved' ? (
        <ExecuteDialog rotation={rotation} />
      ) : null}
    </div>
  )
}

function CoApproveDialog({ rotation }: { rotation: any }) {
  const [open, setOpen] = useState(false)
  const [rationale, setRationale] = useState('')
  const stepUp = useStepUp()
  const approve = useApproveRotation()
  const { toast } = useToast()

  const submit = async () => {
    try {
      await stepUp.ensureRecent(300)
      await approve.mutateAsync({ rotationId: rotation.id, payload: { coApproverRationale: rationale } })
      setOpen(false)
      toast({ title: 'Co-approved', description: 'Rotation may now be executed.' })
    } catch (err: any) {
      if (err.status === 403 && err.body?.error === 'co_approver_must_differ') {
        toast({ title: 'Co-approver must differ', description: 'You are the requester. A different membership must approve.', variant: 'destructive' })
      } else {
        toast({ title: 'Approval failed', description: err.message, variant: 'destructive' })
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Co-approve as Compliance</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Co-approve rotation</DialogTitle>
          <DialogDescription>
            By co-approving you confirm that the rotation is justified and that you have reviewed the requester's rationale. You must be a different membership from the requester.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm border-l-2 pl-3 my-3 italic">{rotation.rationale}</p>
        <RationaleTextArea label="Co-approver rationale" value={rationale} onChange={setRationale} minLength={10} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={rationale.length < 10 || approve.isPending}>Co-approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ExecuteDialog({ rotation }: { rotation: any }) {
  const [open, setOpen] = useState(false)
  const stepUp = useStepUp()
  const execute = useExecuteRotation()
  const { toast } = useToast()

  const submit = async () => {
    try {
      await stepUp.ensureRecent(300)
      const result = await execute.mutateAsync({ rotationId: rotation.id })
      setOpen(false)
      toast({
        title: 'Rotation complete',
        description: `New credential ${result.newCredentialId} is active. The old credential is now in the CRL; listener and outbound client will refuse it within 2 seconds.`,
      })
    } catch (err) {
      toast({ title: 'Execute failed', description: (err as Error).message, variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive">Execute rotation</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm execute</DialogTitle>
          <DialogDescription>
            This will atomically: (1) provision a new credential, (2) retire the current one, (3) emit the CRL refresh event to all listeners and outbound clients. Partner facilities may need to update their trust store within ~24h.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={execute.isPending}>Execute</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

### 3.4 `NppesAdminPage.tsx` (sync runs + provider lookup)

```tsx
// apps/frontend/src/modules/29-external-interfaces/nppes-admin/NppesAdminPage.tsx
import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useSyncRuns, useTriggerSync, useProviderByNpi } from '../_shared/hooks/use-nppes-sync'
import { useStepUp } from '../_shared/hooks/use-step-up'
import { useCurrentUser, hasPermission } from '@wardenx/foundation/auth-client'

export function NppesAdminPage() {
  return (
    <div className="container max-w-5xl py-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">NPPES Sync</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Nightly sync at 02:30 UTC. Manual sync requires step-up authentication.
        </p>
      </header>

      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Sync runs</TabsTrigger>
          <TabsTrigger value="lookup">Provider lookup</TabsTrigger>
        </TabsList>
        <TabsContent value="runs"><SyncRunsTable /></TabsContent>
        <TabsContent value="lookup"><ProviderLookup /></TabsContent>
      </Tabs>
    </div>
  )
}

function SyncRunsTable() {
  const { data: runs, isLoading } = useSyncRuns()
  const trigger = useTriggerSync()
  const stepUp = useStepUp()
  const user = useCurrentUser()
  const canTrigger = hasPermission(user, 'external_interfaces.nppes_sync:trigger_manual')

  const handleTrigger = async () => {
    await stepUp.ensureRecent(300)
    await trigger.mutateAsync()
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Recent runs</CardTitle>
        {canTrigger && (
          <Button onClick={handleTrigger} disabled={trigger.isPending}>
            Trigger manual sync
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full">
          <thead className="bg-muted/50 text-xs uppercase">
            <tr>
              <th className="text-left p-3">Started</th>
              <th className="text-left p-3">Kind</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Providers synced</th>
              <th className="text-right p-3">Deactivations</th>
              <th className="text-right p-3">Errors</th>
            </tr>
          </thead>
          <tbody>
            {runs?.map(r => (
              <tr key={r.id} className="border-t">
                <td className="p-3">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="p-3"><Badge variant="outline">{r.kind}</Badge></td>
                <td className="p-3"><StatusBadge status={r.status} /></td>
                <td className="p-3 text-right">{r.providersSynced}</td>
                <td className="p-3 text-right">{r.deactivationsDetected ?? 0}</td>
                <td className="p-3 text-right">{r.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function ProviderLookup() {
  const [npi, setNpi] = useState('')
  const { data, isLoading, error } = useProviderByNpi(npi.length === 10 ? npi : '')

  return (
    <Card>
      <CardHeader><CardTitle>NPI lookup</CardTitle></CardHeader>
      <CardContent>
        <Input value={npi} onChange={e => setNpi(e.target.value)} placeholder="10-digit NPI" maxLength={10} />
        {data && (
          <div className="mt-4 space-y-2 text-sm">
            <KV label="Name" value={`${data.firstName} ${data.lastName}${data.credential ? `, ${data.credential}` : ''}`} />
            <KV label="Status" value={<Badge variant={data.status === 'A' ? 'default' : 'destructive'}>{data.status === 'A' ? 'Active' : 'Deactivated'}</Badge>} />
            {data.deactivationReason && <KV label="Deactivation reason" value={data.deactivationReason} />}
            <KV label="Primary taxonomy" value={data.taxonomies?.find((t: any) => t.primary)?.desc ?? '—'} />
            <KV label="Last synced" value={new Date(data.syncedAt).toLocaleString()} />
          </div>
        )}
        {error && <p className="text-sm text-destructive mt-4">{(error as any).body?.hint ?? 'NPI not cached. Trigger a sync to fetch.'}</p>}
      </CardContent>
    </Card>
  )
}
```

---

## 4. T-29.13 Deliverable A: Proposal Inbox + Review

### 4.1 `ProposalInboxPage.tsx`

```tsx
// apps/frontend/src/modules/29-external-interfaces/proposals/ProposalInboxPage.tsx
import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Link } from '@tanstack/react-router'
import { useProposals } from '../_shared/hooks/use-proposals'
import { useRealtimeInbox } from '../_shared/hooks/use-realtime-inbox'
import { MatchLevelChip } from '../_shared/components/MatchLevelChip'
import { ProposalStatusChip } from '../_shared/components/ProposalStatusChip'
import { PatientSummaryRow } from '../_shared/components/PatientSummaryRow'
import { EmptyState } from '../_shared/components/EmptyState'

export function ProposalInboxPage() {
  useRealtimeInbox()
  const [ownerModule, setOwnerModule] = useState<'m5' | 'm6' | 'all'>('all')

  return (
    <div className="container max-w-7xl py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Inbound proposal inbox</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Per propose-then-review semantics, every external ADT update lands here for clinician review. No external chart mutations happen without an accept decision.
        </p>
      </header>

      <Tabs value={ownerModule} onValueChange={v => setOwnerModule(v as any)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="m5">Patient demographics</TabsTrigger>
          <TabsTrigger value="m6">Admission / discharge / cancel</TabsTrigger>
        </TabsList>
        <TabsContent value={ownerModule}>
          <ProposalList ownerModule={ownerModule === 'all' ? undefined : ownerModule} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ProposalList({ ownerModule }: { ownerModule?: 'm5' | 'm6' }) {
  const { data, isLoading } = useProposals({ ownerModule, proposalStatus: 'pending' })
  if (isLoading) return <InboxSkeleton />
  if (!data || data.length === 0) return <EmptyState title="No pending proposals" body="When external ADT messages arrive that need review, they will appear here." />

  return (
    <div className="space-y-3">
      {data.map(p => (
        <Card key={p.id} className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline">{p.resourceKind}</Badge>
                <MatchLevelChip level={p.matchLevel} />
                <ProposalStatusChip status={p.proposalStatus} />
                <span className="text-xs text-muted-foreground">
                  {new Date(p.proposedAt).toLocaleString()}
                </span>
              </div>
              <PatientSummaryRow
                candidate={p.proposedPatientCandidate}
                matchedPatientId={p.matchedPatientId}
                matchOutcome={p.matchOutcome}
              />
            </div>
            <Button asChild>
              <Link to="/external-interfaces/inbound-proposals/$id" params={{ id: p.id }}>
                Review →
              </Link>
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

### 4.2 `ProposalReviewPage.tsx` (diff + accept/reject/discard)

```tsx
// apps/frontend/src/modules/29-external-interfaces/proposals/ProposalReviewPage.tsx
import { useState } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useProposal, useAcceptProposal, useRejectProposal, useDiscardProposal } from '../_shared/hooks/use-proposals'
import { useStepUp } from '../_shared/hooks/use-step-up'
import { RationaleTextArea } from '../_shared/components/RationaleTextArea'
import { MatchLevelChip } from '../_shared/components/MatchLevelChip'
import { useToast } from '@/components/ui/toast'

export function ProposalReviewPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { data: proposal, isLoading } = useProposal(id)
  if (isLoading) return <ReviewSkeleton />
  if (!proposal) return <NotFound />

  return (
    <div className="container max-w-5xl py-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Review proposal</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {proposal.resourceKind} · owner {proposal.ownerModule} · match level <MatchLevelChip level={proposal.matchLevel} />
        </p>
      </header>

      <Tabs defaultValue="diff">
        <TabsList>
          <TabsTrigger value="diff">Proposed changes</TabsTrigger>
          <TabsTrigger value="source">Source message</TabsTrigger>
          <TabsTrigger value="match">Match cascade</TabsTrigger>
        </TabsList>

        <TabsContent value="diff">
          <FieldDiffPanel proposal={proposal} />
        </TabsContent>
        <TabsContent value="source">
          <SourceMessagePanel proposal={proposal} />
        </TabsContent>
        <TabsContent value="match">
          <MatchCascadePanel proposal={proposal} />
        </TabsContent>
      </Tabs>

      <ProposalDecisionPanel proposal={proposal} />
    </div>
  )
}

function FieldDiffPanel({ proposal }: { proposal: any }) {
  // Compare proposedPatientCandidate (incoming) vs current matched patient (if any)
  const candidate = proposal.proposedPatientCandidate
  const matched = useMatchedPatient(proposal.matchedPatientId)  // hook to M5 reader

  if (!matched) {
    return (
      <Card>
        <CardHeader><CardTitle>New patient (no match)</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            No existing patient matched. Accepting this proposal will create a new M5 patient row.
          </p>
          <CandidateFields candidate={candidate} />
        </CardContent>
      </Card>
    )
  }

  // Diff table — green for incoming, gray for unchanged, yellow for proposed update
  return (
    <Card>
      <CardHeader>
        <CardTitle>Field-by-field comparison</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldDiffTable matched={matched} candidate={candidate} />
      </CardContent>
    </Card>
  )
}

function ProposalDecisionPanel({ proposal }: { proposal: any }) {
  const [appliedFields, setAppliedFields] = useState<string[]>([])
  const [rationale, setRationale] = useState('')
  const stepUp = useStepUp()
  const accept = useAcceptProposal()
  const reject = useRejectProposal()
  const discard = useDiscardProposal()
  const navigate = useNavigate()
  const { toast } = useToast()

  const submitAccept = async (partial: boolean) => {
    try {
      await stepUp.ensureRecent(300)
      await accept.mutateAsync({
        id: proposal.id,
        payload: partial ? { appliedFields, decisionRationale: rationale } : { decisionRationale: rationale },
      })
      toast({ title: 'Accepted', description: `Sent to ${proposal.ownerModule.toUpperCase()} for application.` })
      navigate({ to: '/external-interfaces/inbound-proposals' })
    } catch (err) {
      toast({ title: 'Accept failed', description: (err as Error).message, variant: 'destructive' })
    }
  }

  const submitReject = async () => {
    if (rationale.trim().length < 1) {
      toast({ title: 'Rationale required', variant: 'destructive' })
      return
    }
    await reject.mutateAsync({ id: proposal.id, payload: { decisionRationale: rationale } })
    navigate({ to: '/external-interfaces/inbound-proposals' })
  }

  const submitDiscard = async () => {
    if (rationale.trim().length < 10) {
      toast({ title: 'Discard requires a longer rationale (≥10 chars)', variant: 'destructive' })
      return
    }
    await stepUp.ensureRecent(300)
    await discard.mutateAsync({ id: proposal.id, payload: { decisionRationale: rationale } })
    navigate({ to: '/external-interfaces/inbound-proposals' })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decision</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <RationaleTextArea
          label="Decision rationale (required for reject / discard)"
          value={rationale}
          onChange={setRationale}
          minLength={1}
          placeholder="e.g. Verified address with patient family; phone matches existing chart."
        />

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => submitAccept(false)} disabled={accept.isPending}>
            Accept all fields
          </Button>
          <Button variant="outline" onClick={() => submitAccept(true)} disabled={appliedFields.length === 0 || accept.isPending}>
            Accept selected ({appliedFields.length})
          </Button>
          <Button variant="secondary" onClick={submitReject} disabled={reject.isPending}>
            Reject
          </Button>
          <Button variant="destructive" onClick={submitDiscard} disabled={discard.isPending}>
            Discard
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
```

---

## 5. T-29.13 Deliverable B: Unmatched Lab Queue

```tsx
// apps/frontend/src/modules/29-external-interfaces/unmatched-labs/UnmatchedLabsPage.tsx
import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useUnmatchedLabs, useBindLab, useDiscardLab } from '../_shared/hooks/use-unmatched-labs'
import { useRealtimeInbox } from '../_shared/hooks/use-realtime-inbox'
import { PatientPickerDialog } from './PatientPickerDialog'
import { LabValuesTable } from './LabValuesTable'
import { SudRedactionBadge } from '../_shared/components/SudRedactionBadge'
import { useStepUp } from '../_shared/hooks/use-step-up'

export function UnmatchedLabsPage() {
  useRealtimeInbox()
  const { data, isLoading } = useUnmatchedLabs()
  if (isLoading) return <UnmatchedSkeleton />
  if (!data || data.length === 0) return <EmptyState title="No unmatched labs" body="Lab results that couldn't be auto-attached will appear here for review." />

  return (
    <div className="container max-w-7xl py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Unmatched labs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Lab observations with a candidate match or no match. Bind to a patient to attach the values to their chart, or discard if the lab is invalid.
        </p>
      </header>

      <div className="space-y-3">
        {data.map(item => (
          <UnmatchedLabCard key={item.observation.id} item={item} />
        ))}
      </div>
    </div>
  )
}

function UnmatchedLabCard({ item }: { item: { observation: any; link: any } }) {
  const [bindOpen, setBindOpen] = useState(false)
  const stepUp = useStepUp()
  const bind = useBindLab()
  const discard = useDiscardLab()

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{item.observation.universalServiceText || 'Lab observation'}</Badge>
            <Badge variant="secondary">match: {item.link.matchMethod}</Badge>
            <SudRedactionBadge status={item.observation.sudRedactionStatus} />
            <span className="text-xs text-muted-foreground">
              received {new Date(item.observation.receivedAt).toLocaleString()}
            </span>
          </div>
          <div className="flex gap-2">
            {item.link.candidatePatientId && (
              <Button variant="outline" size="sm" onClick={async () => {
                await stepUp.ensureRecent(300)
                await bind.mutateAsync({
                  id: item.observation.id,
                  payload: {
                    patientId: item.link.candidatePatientId,
                    decisionRationale: 'Confirmed candidate via demographic match L4',
                  },
                })
              }}>
                Accept candidate match
              </Button>
            )}
            <Button size="sm" onClick={() => setBindOpen(true)}>
              Bind to patient
            </Button>
            <Button size="sm" variant="ghost" onClick={() => {/* discard flow */}}>
              Discard
            </Button>
          </div>
        </div>

        <LabValuesTable observationId={item.observation.id} sudStatus={item.observation.sudRedactionStatus} />
      </CardContent>

      <PatientPickerDialog
        open={bindOpen}
        onOpenChange={setBindOpen}
        onPicked={async (patientId, rationale) => {
          await stepUp.ensureRecent(300)
          await bind.mutateAsync({ id: item.observation.id, payload: { patientId, decisionRationale: rationale } })
          setBindOpen(false)
        }}
      />
    </Card>
  )
}
```

---

## 6. T-29.13 Deliverable C: SUD Privileged Unredact

```tsx
// apps/frontend/src/modules/29-external-interfaces/unmatched-labs/SudUnredactRequestDialog.tsx
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { RationaleTextArea } from '../_shared/components/RationaleTextArea'
import { useRequestSudUnredact } from '../_shared/hooks/use-sud-unredact'
import { useStepUp } from '../_shared/hooks/use-step-up'

export function SudUnredactRequestDialog({
  observationId, open, onOpenChange, onGrantCreated,
}: {
  observationId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onGrantCreated: (grantId: string, emergencyBasis: boolean) => void
}) {
  const [rationale, setRationale] = useState('')
  const [emergencyBasis, setEmergencyBasis] = useState(false)
  const [emergencyConfirmed, setEmergencyConfirmed] = useState(false)
  const requestGrant = useRequestSudUnredact()
  const stepUp = useStepUp()

  const canSubmit = rationale.length >= 50 && (!emergencyBasis || emergencyConfirmed)

  const submit = async () => {
    await stepUp.ensureRecent(300)
    const result = await requestGrant.mutateAsync({
      observationId,
      payload: { clinicalRationale: rationale, emergencyBasis42cfr2_51: emergencyBasis },
    })
    onGrantCreated(result.grantId, emergencyBasis)
    onOpenChange(false)
    setRationale('')
    setEmergencyBasis(false)
    setEmergencyConfirmed(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request SUD unredact grant</DialogTitle>
          <DialogDescription>
            This observation contains substance-use-disorder information protected under 42 CFR Part 2. The patient's consent is not on file (or has been withdrawn). Unredacting requires a documented clinical rationale and (in the standard path) a second-membership approval. Every disclosure is logged in the Part 2 audit register with the longest retention class.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="warning">
          <AlertTitle>Note</AlertTitle>
          <AlertDescription>
            The grant exercises ephemerally — the value is returned in the response but is NOT persisted in cleartext. The observation remains redacted. Re-exercising the grant requires another audit-logged action.
          </AlertDescription>
        </Alert>

        <RationaleTextArea
          label="Clinical rationale (minimum 50 characters)"
          value={rationale}
          onChange={setRationale}
          minLength={50}
          placeholder="e.g. Patient presented to ED with altered mental status; need to confirm substance for treatment direction; family unable to consent at this time."
        />

        <div className="border-t pt-4 space-y-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <Checkbox checked={emergencyBasis} onCheckedChange={(v) => setEmergencyBasis(!!v)} />
            <div>
              <p className="font-medium text-sm">Emergency basis under 42 CFR §2.51</p>
              <p className="text-xs text-muted-foreground">
                Bypass dual-approval; exercise immediately. Requires documented medical emergency.
              </p>
            </div>
          </label>

          {emergencyBasis && (
            <Alert variant="destructive">
              <AlertTitle>Emergency disclosure under §2.51</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>I attest that the patient meets the standard of a medical emergency under 42 CFR §2.51: the disclosure is necessary to meet a genuine medical emergency, and prior consent could not be obtained.</p>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={emergencyConfirmed} onCheckedChange={(v) => setEmergencyConfirmed(!!v)} />
                  <span className="text-sm">I attest to the above</span>
                </label>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit || requestGrant.isPending}>
            {emergencyBasis ? 'Request emergency grant' : 'Request grant (awaits approval)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

---

## 7. Routing

```tsx
// apps/frontend/src/modules/29-external-interfaces/routes.ts
import { createRoute, createRootRouteWithContext } from '@tanstack/react-router'

export const m29Route = createRoute({
  path: '/external-interfaces',
  // requires the `external_interfaces.feed:read` permission baseline
  beforeLoad: requirePermission('external_interfaces.feed:read'),
  component: M29Layout,
})

// T-29.12
export const feedListRoute = createRoute({ getParentRoute: () => m29Route, path: 'feeds', component: FeedListPage })
export const feedDetailRoute = createRoute({ getParentRoute: () => m29Route, path: 'feeds/$feedId', component: FeedDetailPage })
export const nppesAdminRoute = createRoute({ getParentRoute: () => m29Route, path: 'nppes', component: NppesAdminPage })

// T-29.13
export const proposalInboxRoute = createRoute({
  getParentRoute: () => m29Route,
  path: 'inbound-proposals',
  beforeLoad: requirePermission('external_interfaces.inbound_proposal:list'),
  component: ProposalInboxPage,
})
export const proposalReviewRoute = createRoute({
  getParentRoute: () => m29Route,
  path: 'inbound-proposals/$id',
  beforeLoad: requirePermission('external_interfaces.inbound_proposal:read'),
  component: ProposalReviewPage,
})
export const unmatchedLabsRoute = createRoute({
  getParentRoute: () => m29Route,
  path: 'unmatched-labs',
  beforeLoad: requirePermission('external_interfaces.unmatched_lab:list'),
  component: UnmatchedLabsPage,
})
```

---

## 8. Tests

Component + integration. Component tests use Vitest + React Testing Library; integration tests run against a Playwright environment with seeded backend fixtures.

### 8.1 Component tests (representative)

```tsx
// CredentialRotationCard.test.tsx
describe('CredentialRotationCard', () => {
  it('hides rotate button when user lacks permission', () => {
    renderWithUser({ permissions: ['external_interfaces.feed_credential:read'] })
    expect(screen.queryByRole('button', { name: /rotate credential/i })).not.toBeInTheDocument()
  })

  it('shows pending rotation panel with co-approve button only for non-requester', () => {
    renderWithRotation({
      rotation: { state: 'requested', requesterMembershipId: 'mem_other' },
      user: { membershipId: 'mem_self', permissions: ['external_interfaces.feed_credential:rotate'] },
    })
    expect(screen.getByRole('button', { name: /co-approve as compliance/i })).toBeInTheDocument()
  })

  it('hides co-approve button when user IS requester', () => {
    renderWithRotation({
      rotation: { state: 'requested', requesterMembershipId: 'mem_self' },
      user: { membershipId: 'mem_self' },
    })
    expect(screen.queryByRole('button', { name: /co-approve/i })).not.toBeInTheDocument()
    expect(screen.getByText(/cannot self-approve/i)).toBeInTheDocument()
  })
})

// ProposalReviewPage.test.tsx
describe('ProposalReviewPage decision panel', () => {
  it('disables reject when rationale is empty', () => {
    renderProposal({})
    fireEvent.click(screen.getByRole('button', { name: /reject/i }))
    expect(screen.getByText(/rationale required/i)).toBeInTheDocument()
  })

  it('disables accept selected when no fields are selected', () => {
    renderProposal({})
    const btn = screen.getByRole('button', { name: /accept selected/i })
    expect(btn).toBeDisabled()
  })
})

// SudUnredactRequestDialog.test.tsx
describe('SudUnredactRequestDialog', () => {
  it('emergency-basis path requires explicit attestation checkbox', () => {
    render(<SudUnredactRequestDialog open observationId="obs_1" />)
    fireEvent.change(screen.getByLabelText(/clinical rationale/i), { target: { value: 'a'.repeat(60) } })
    fireEvent.click(screen.getByLabelText(/emergency basis/i))

    expect(screen.getByRole('button', { name: /request emergency grant/i })).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/i attest to the above/i))
    expect(screen.getByRole('button', { name: /request emergency grant/i })).toBeEnabled()
  })
})
```

### 8.2 Playwright integration tests (representative)

```tsx
// test/e2e/proposal-flow.spec.ts
test('W-XI-03 end-to-end: review proposal → accept selected fields → M5 forward-stub records the apply event', async ({ page, fixtures }) => {
  await fixtures.proposal({ id: 'prop_w03', ownerModule: 'm5', proposalStatus: 'pending', resourceKind: 'patient_demographic_update' })
  await loginAs(page, 'rn_with_m5_edit')

  await page.goto('/external-interfaces/inbound-proposals')
  await expect(page.getByText('patient_demographic_update')).toBeVisible()
  await page.getByRole('link', { name: /review/i }).click()

  // Check 2 fields, enter rationale, accept selected
  await page.getByLabel('address_line1').check()
  await page.getByLabel('address_city').check()
  await page.getByLabel(/decision rationale/i).fill('Address verified by phone')

  // Step-up modal appears
  await page.getByRole('button', { name: /accept selected/i }).click()
  await expect(page.getByText(/step-up required/i)).toBeVisible()
  await fixtures.completeStepUp(page)

  // Toast shows success
  await expect(page.getByText(/sent to M5 for application/i)).toBeVisible()

  // Outbox event verified
  const events = await fixtures.outboxEvents()
  expect(events.find(e => e.name === 'm29.hl7_inbound_proposal.accepted' && e.payload.appliedFields.length === 2)).toBeDefined()
})

test('rotation flow: request, switch user to co-approve, switch back to execute', async ({ page, fixtures }) => {
  const feed = await fixtures.feed({ id: 'feed_e2e' })
  await fixtures.activeCredential(feed)

  // User A requests
  await loginAs(page, 'user_a_with_rotate_perm')
  await page.goto(`/external-interfaces/feeds/${feed.id}`)
  await page.getByRole('button', { name: /rotate credential/i }).click()
  await page.getByLabel(/rationale/i).fill('Quarterly per policy')
  await page.getByRole('button', { name: /submit request/i }).click()
  await fixtures.completeStepUp(page)
  await expect(page.getByText(/awaiting co-approval/i)).toBeVisible()

  // User B co-approves
  await loginAs(page, 'user_b_with_rotate_perm')
  await page.goto(`/external-interfaces/feeds/${feed.id}`)
  await page.getByRole('button', { name: /co-approve/i }).click()
  await page.getByLabel(/co-approver rationale/i).fill('Compliance reviewed; security policy current')
  await page.getByRole('button', { name: /co-approve$/i }).click()
  await fixtures.completeStepUp(page)

  // User A executes
  await loginAs(page, 'user_a_with_rotate_perm')
  await page.goto(`/external-interfaces/feeds/${feed.id}`)
  await page.getByRole('button', { name: /execute rotation/i }).click()
  await page.getByRole('button', { name: /^execute$/i }).click()
  await fixtures.completeStepUp(page)
  await expect(page.getByText(/rotation complete/i)).toBeVisible()
})

test('unmatched lab bind: SUD redaction badge visible; bind triggers recheck', async ({ page, fixtures }) => {
  await fixtures.unmatchedLab({ sudRedactionStatus: 'redacted_default_on' })
  await loginAs(page, 'rn_with_bind_perm')
  await page.goto('/external-interfaces/unmatched-labs')

  await expect(page.getByText(/redacted: default-on/i)).toBeVisible()
  await page.getByRole('button', { name: /bind to patient/i }).click()
  await page.fill('input[name="patient-search"]', 'Jane Doe')
  await page.getByText('Jane Doe').click()
  await page.getByLabel(/rationale/i).fill('Confirmed via phone')
  await page.getByRole('button', { name: /bind/i }).click()
  await fixtures.completeStepUp(page)

  // After bind, the recheck transitioned status
  const obs = await fixtures.observation()
  expect(['unredacted_consent_explicit', 'redacted_consent_absent']).toContain(obs.sudRedactionStatus)
})

test('SUD emergency-basis unredact: §2.51 path returns plaintext, audit row written', async ({ page, fixtures }) => {
  const obs = await fixtures.observation({ sudRedactionStatus: 'redacted_consent_absent' })
  await loginAs(page, 'clinician_with_sud_request_and_exercise')

  await page.goto(`/external-interfaces/lab-observations/${obs.id}/sud-unredact-request`)
  await page.getByLabel(/clinical rationale/i).fill('Patient unconscious in ED; substance ID needed for treatment direction; family unreachable.')
  await page.getByLabel(/emergency basis/i).check()
  await page.getByLabel(/i attest to the above/i).check()
  await page.getByRole('button', { name: /request emergency grant/i }).click()
  await fixtures.completeStepUp(page)

  // Plaintext visible
  await expect(page.getByTestId('unredacted-value')).toContainText('POSITIVE')

  const audits = await fixtures.partTwoAudits(obs.id)
  expect(audits.some(a => a.action === 'sud.unredact.emergency_request')).toBe(true)
  expect(audits.some(a => a.action === 'sud.unredact.exercise')).toBe(true)
})
```

---

## 9. Sign-Off Checklist

### 9.1 T-29.12 PR

- [ ] Feed list, detail, create, suspend pages land.
- [ ] Credential rotation card with request → co-approve → execute flow lands.
- [ ] NPPES admin pages (runs + lookup + manual trigger) land.
- [ ] All UI permission gates respect M29 permission keys (no UI surface visible without backing permission).
- [ ] Step-up modal triggered before every step-up-required action.
- [ ] Toast notifications surface backend errors (especially 403 distinct-approver, 409 state-mismatch, 410 expired).
- [ ] Component tests pass.
- [ ] Playwright rotation flow test passes.
- [ ] Accessibility: keyboard navigation works on every modal; ARIA labels on all interactive elements; color is not the only signal (chips + text).
- [ ] **Design system sign-off** on the visual language (badges, chips, status colors).
- [ ] **Compliance officer sign-off** on the rotation UI copy (the "Confirm execute" dialog wording).

### 9.2 T-29.13 PR

- [ ] Proposal inbox + review pages land with diff view, source view, match cascade view.
- [ ] Unmatched lab queue + bind + discard flows land.
- [ ] SUD privileged unredact request dialog with both standard and §2.51 emergency paths lands.
- [ ] Realtime updates via Socket.IO refresh the inbox on backend events.
- [ ] Empty states + loading skeletons for every list page.
- [ ] Mobile-friendly inbox (Capacitor wrapper compatible).
- [ ] All UI permission gates respect M29 permission keys.
- [ ] Component tests pass.
- [ ] Playwright tests pass for proposal accept, unmatched-lab bind, SUD emergency unredact.
- [ ] **Clinical engineering sign-off** on the propose-then-review wording (especially that "no chart mutation happens without accept" is communicated clearly).
- [ ] **Privacy engineer sign-off** on the SUD unredact dialog — particularly the emergency-basis attestation language matching 42 CFR §2.51 wording.
- [ ] **Compliance officer sign-off** on the Part 2 audit messaging in the SUD UI.

---

## 10. Notes on Refinements Past M29 Spec v0.3 (UI)

1. **`sendingFacilityAllowlist` editor** — T-29.12's PartnerAllowlistEditor is a small component the spec didn't enumerate but follows naturally from the `external_feed.sending_facility_allowlist` JSONB field. CIDR validation client-side; server confirms.

2. **Field-by-field diff for proposals.** The spec §5.1.2 mentioned "review queue" without specifying the diff visualization. T-29.13 pins it: side-by-side comparison with field-level checkboxes for partial accept. Future M29 spec patch could reference this UI pattern as canonical.

3. **Emergency-basis attestation copy.** The §2.51 emergency path requires the clinician to attest in writing. T-29.13 ships the attestation language; that language is compliance-reviewable and not architect-decided. Worth documenting in the compliance-policy folder.

4. **Real-time inbox invalidation pattern.** The `useRealtimeInbox` hook is reusable beyond M29; M28 (FHIR Gateway operator views) and M30 (HQRP) will follow the same pattern. Worth promoting to a shared `useModuleInbox` hook in the foundation package.

5. **Step-up modal trigger discipline.** Every step-up-gated route on the backend gets a step-up trigger on the frontend. The pattern `await stepUp.ensureRecent(300)` is consistent throughout; M2 v0.3 could document this as the canonical client-side step-up integration.

---

## Document Footer

**Addendum version:** v1.0 (T-29.12 + T-29.13 PR-ready)
**Bound to:** M29 v0.3 §5, §10 (T-29.12, T-29.13)
**Files delivered (T-29.12):** ~12 components + 5 hooks + routing entries
**Files delivered (T-29.13):** ~10 components + 4 hooks + routing entries
**Workflows surfaced:** W-XI-01 (review UI), W-XI-02, W-XI-03 (partial-accept UI), W-XI-04 (reject rationale UI), W-XI-05, W-XI-06 (unmatched-lab bind UI), W-XI-08 (SUD UI), W-XI-13 (rotation UI), W-XI-15 (NPPES admin UI)
**Sign-offs required:** Design system, Compliance officer, Clinical engineering, Privacy engineer

**End of T-29.12 / T-29.13 combined frontend addendum.**
