// apps/backend/src/modules/10-hope/outbox-port.ts — the M10 transactional-outbox port (§2.4).
//
// A LEAF: it declares a type and imports nothing from the module, so both the write backend
// (hope-route-service-db.ts) and the schedule writer (scheduling/schedule-writer.ts) can name the
// port without depending on each other. It used to live in hope-route-service-db.ts, which made
// schedule-writer.ts — imported BY that same file for the §4.1 route-20 regenerate — import back
// into it, a cycle `arch:boundaries` rejects (no-circular). Moving the declaration rather than
// duplicating it keeps ONE definition of the port: the bound publisher, the no-op default and the
// two call sites all still agree by construction.

/** The transactional-outbox port (§2.4): the bound publisher validates every emit against the boot
 * catalog and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests
 * commit without a dispatcher. Mirrors M7/M8/M9. */
export interface HopeWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
