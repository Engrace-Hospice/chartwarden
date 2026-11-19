// apps/backend/src/modules/08-encounters/closure/closure-alert-catalog.ts — M8's visit-note closure alerts on the typed alert-payload catalog (ADR-0113 D5).
//
// `M8_CLOSURE_ALERT_PAYLOADS` (packages/types) is M8's contribution to the Foundation alert-payload registry. Until it was bound at
// boot it was registered only by tests, so nothing checked what the `encounter.attention` sweep really emits. The composition root
// (index.ts) registers the catalog here, which asserts it is well-formed and collision-free AT BOOT (a bad contribution fails the boot,
// not a 15-minute tick), and wraps the M8 workers' emitter so every closure payload is checked against its schema before it is sent: a malformed
// payload throws here (the sweep reports the organization as failed) instead of reaching an inbox. Same shape as the M14 alert
// consumers (`buildIdgAlertConsumers`), which take the catalog the composition root builds.
import type { AlertEmitter, AlertPayloadRegistry } from "@chartwarden/messaging";
import {
  type AlertPayloadEntry,
  ChartWardenError,
  M8_CLOSURE_ALERT_PAYLOADS,
} from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";

export const CLOSURE_ALERT_PAYLOAD_INVALID_CODE = "M8_CLOSURE_ALERT_PAYLOAD_INVALID";
const HTTP_INTERNAL = 500;

/**
 * Register M8's closure alerts on the Foundation `registry` the composition root created, assert it well-formed and collision-free
 * (throws on a malformed entry or a duplicate type), and return the `payloadType -> entry` map. The registry is passed in, not created
 * here: the composition root (index.ts) creates it, and it builds one registry per consumer group (this M8 one, and one for each of the
 * M14 alert consumers), each separate, so a contribution registered on one is not visible on another.
 */
export function registerClosureAlertCatalog(
  registry: AlertPayloadRegistry,
): ReadonlyMap<string, AlertPayloadEntry> {
  registry.register(M8_CLOSURE_ALERT_PAYLOADS);
  registry.assertValid();
  return registry.build();
}

/**
 * An emitter that checks every alert of a type in `catalog` against that type's payload schema before it reaches `emitter`, and
 * throws when the payload does not fit (the message names the event type and the failing schema paths, never a value). An alert of
 * any other type passes through untouched: the M8 worker deps carry one emitter for the closure sweep AND the cosignature crons, so
 * the wrapper must not reject the latter.
 */
export function withClosureAlertCatalog(
  emitter: AlertEmitter,
  catalog: ReadonlyMap<string, AlertPayloadEntry>,
): AlertEmitter {
  return {
    async emit(organizationId, input) {
      const entry = catalog.get(input.eventType);
      if (entry !== undefined && !Value.Check(entry.payloadSchema, input.payload)) {
        const paths = [...Value.Errors(entry.payloadSchema, input.payload)].map((e) => e.path);
        throw new ChartWardenError(
          CLOSURE_ALERT_PAYLOAD_INVALID_CODE,
          `${input.eventType} payload fails its catalog schema at: ${paths.join(", ")}`,
          HTTP_INTERNAL,
        );
      }
      return emitter.emit(organizationId, input);
    },
  };
}
