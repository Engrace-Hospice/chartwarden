// WP 2.7b C2 (ADR-0058, Accepted) - the ONE composition call for the global search writer side, so apps/backend/src/index.ts
// carries a single registration block. It builds the writer, the outbox consumer `m36.message-search-indexer`, and (when a
// queue connection and the active-org enumerator exist) the `messaging.search_maintenance` worker + its schedule.
//
// Nothing is indexed until operators enable it: the tenant flag defaults OFF, the platform flag is absent (= OFF), and `keys`
// is the ring-backed provider (throws, fail closed, while no ring is bound or the ring is destroyed). The consumer is registered unconditionally (the catalog's declared `m36` consumer must be bound);
// with the flags off it completes without doing work.
import type { DbClient } from "@wardenx/db";
import type { SearchKeyProvider } from "@wardenx/messaging";
import type { ConnectionOptions, Queue, Worker } from "bullmq";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { M36IntegrityWorkerDeps } from "../jobs/integrity-workers";
import type { MessageBodyCipher } from "../messaging-write-core";
import { type IndexWriter, type IndexWriterDeps, createIndexWriter } from "./index-writer";
import { buildM36MessageSearchIndexerConsumer } from "./indexer-consumer";
import {
  registerGlobalSearchMaintenanceWorker,
  scheduleGlobalSearchMaintenance,
} from "./maintenance-worker";
import type { NameExclusions } from "./name-exclusion";
import { createPlatformSearchFlag } from "./platform-flag";
import { type IsRedactedOrPending, createBodyReader, neverRedacted } from "./ports";
import type { ReconcileDeps } from "./reconcile";
import { createTenantSearchSettingStore } from "./tenant-setting-store";

export interface RegisterGlobalSearchDeps {
  readonly db: DbClient;
  readonly cipher: Pick<MessageBodyCipher, "open">;
  /** Production: `createUnavailableSearchKeyProvider()` until P1 lands. */
  readonly keys: SearchKeyProvider;
  /** Production: the shared `createNameExclusions` over M5's name enumeration. Required: no default would index names. */
  readonly exclusions: NameExclusions;
  readonly isRedactedOrPending?: IsRedactedOrPending;
  readonly onIndexError?: IndexWriterDeps["onError"];
  /** Absent on a boot without a queue connection or platform pool: only the consumer is built then. */
  readonly worker?: {
    readonly connection: ConnectionOptions;
    readonly activeOrgs: M36IntegrityWorkerDeps["activeOrgs"];
    readonly onError?: M36IntegrityWorkerDeps["onError"];
  };
}

export interface GlobalSearchRegistration {
  readonly consumer: OutboxConsumerBinding;
  readonly writer: IndexWriter;
  readonly reconcile: ReconcileDeps;
  readonly workers: readonly Worker[];
  readonly queues: readonly Queue[];
  close(): Promise<void>;
}

export async function registerM36GlobalSearch(
  deps: RegisterGlobalSearchDeps,
): Promise<GlobalSearchRegistration> {
  const platformFlag = createPlatformSearchFlag(deps.db);
  const writerDeps = {
    db: deps.db,
    bodies: createBodyReader(deps.cipher),
    keys: deps.keys,
    exclusions: deps.exclusions,
    platformFlag,
    isRedactedOrPending: deps.isRedactedOrPending ?? neverRedacted,
    ...(deps.onIndexError ? { onError: deps.onIndexError } : {}),
  };
  const writer = createIndexWriter(writerDeps);
  const reconcile: ReconcileDeps = {
    ...writerDeps,
    writer,
    settings: createTenantSearchSettingStore(deps.db),
  };

  let workers: Worker[] = [];
  let queues: Queue[] = [];
  if (deps.worker) {
    workers = registerGlobalSearchMaintenanceWorker({ ...deps.worker, reconcile });
    queues = await scheduleGlobalSearchMaintenance(deps.worker.connection);
  }
  return {
    consumer: buildM36MessageSearchIndexerConsumer(writer),
    writer,
    reconcile,
    workers,
    queues,
    close: async () => {
      await Promise.all([...workers.map((w) => w.close()), ...queues.map((q) => q.close())]);
    },
  };
}
