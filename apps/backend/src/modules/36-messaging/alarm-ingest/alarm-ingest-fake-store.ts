// M36 WP 6.10 (ADR-0101) - an in-memory AlarmIngestStore and a fake sealing cipher for the unit and route tests (the SQL is proven by the live suite).
import type { AlarmMappingInput } from "@chartwarden/types";
import type {
  AlarmIngestStore,
  EventRow,
  IngestSource,
  NewEvent,
  SourceView,
} from "./alarm-ingest-store";

const NOW = new Date("2026-10-23T12:00:00.000Z");

/** A cipher that "seals" by prefixing, so a test can tell sealed from plain. */
export const fakeAlarmCipher = {
  async sealRing(_org: string, plain: string) {
    return { cipher: Buffer.from(`sealed:${plain}`), sha256: "x" };
  },
  async open(_org: string, c: Buffer) {
    return c.toString("utf8").replace(/^sealed:/, "");
  },
};

export function makeFakeAlarmIngestStore() {
  const sources = new Map<string, SourceView & { org: string; cipher: Buffer }>();
  const events: (EventRow & { org: string; sourceId: string; eventId: string })[] = [];
  const store: AlarmIngestStore = {
    async loadSource(org, id): Promise<IngestSource | null> {
      const s = sources.get(id);
      if (!s || s.org !== org) return null;
      return {
        id,
        enabled: s.enabled,
        secretCipher: s.cipher,
        mappings: new Map(
          s.mappings.map((m) => [
            m.alarmKind,
            { alertType: m.alertType, severityCeiling: m.severityCeiling },
          ]),
        ),
      };
    },
    async recordEvent(org, e: NewEvent) {
      const existing = events.find(
        (x) => x.org === org && x.sourceId === e.sourceId && x.eventId === e.eventId,
      );
      if (existing) return { row: existing, created: false };
      const row = {
        id: `ev-${events.length + 1}`,
        org,
        sourceId: e.sourceId,
        eventId: e.eventId,
        status: e.alertType === null ? ("unmapped" as const) : ("received" as const),
        payloadDigest: e.payloadDigest,
        alertType: e.alertType,
        effectiveSeverity: e.effectiveSeverity,
      };
      events.push(row);
      return { row, created: true };
    },
    async settleEvent(_org, id, outcome) {
      const row = events.find((x) => x.id === id);
      if (row && row.status === "received") (row as { status: string }).status = outcome;
    },
    async createSource(actor, input) {
      const id = `44444444-4444-4444-8444-${String(sources.size + 1).padStart(12, "0")}`;
      const view = {
        id,
        org: actor.organizationId,
        cipher: input.secretCipher,
        name: input.name,
        enabled: true,
        secretGeneration: 1,
        createdAt: NOW,
        rotatedAt: null,
        disabledAt: null,
        lastAcceptedAt: null,
        mappings: input.mappings,
        last24h: { alerted: 0, noRecipients: 0, unmapped: 0, pending: 0 },
      };
      if ([...sources.values()].filter((s) => s.enabled).length >= input.maxSources)
        return "cap_reached";
      sources.set(id, view);
      return view;
    },
    async listSources(actor) {
      return [...sources.values()].filter((s) => s.org === actor.organizationId);
    },
    async rotateSource(actor, id, c) {
      const s = sources.get(id);
      if (!s || s.org !== actor.organizationId || !s.enabled) return null;
      const next = { ...s, cipher: c, secretGeneration: s.secretGeneration + 1 };
      sources.set(id, next);
      return next;
    },
    async disableSource(actor, id) {
      const s = sources.get(id);
      if (!s || s.org !== actor.organizationId) return null;
      const next = { ...s, enabled: false };
      sources.set(id, next);
      return next;
    },
  };
  return { store, sources, events };
}

