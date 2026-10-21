// apps/backend/__tests__/m5-wristband-verifier.test.ts -- GAP-020: M5's PatientWristbandVerifier decides every
// verdict branch over an in-memory store (the DB-backed store is proven live in m5-patient-wristband.live.test.ts).
import { OFFLINE_WRISTBAND_MAX_AGE_MS, formatWristbandPayload } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { wristbandDigest } from "../src/modules/05-patient/wristband-digest";
import {
  type WristbandRow,
  type WristbandVerifierStore,
  createWristbandVerifier,
} from "../src/modules/05-patient/wristband-verifier";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PAT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const payloadOf = (seed: number): string =>
  formatWristbandPayload(Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i * 7) & 0xff));
const tokenOf = (payload: string): string => payload.slice(0, payload.lastIndexOf("."));

interface Seed {
  readonly org?: string;
  readonly patientId: string;
  readonly payload: string;
  readonly generation: number;
  readonly issuedAt: Date;
  readonly supersededAt?: Date | null;
  readonly voidedAt?: Date | null;
}

function storeOf(
  seeds: readonly Seed[],
  unreadable: readonly string[] = [],
): WristbandVerifierStore {
  const rows = seeds.map((s) => ({
    org: s.org ?? ORG,
    digest: wristbandDigest(s.org ?? ORG, tokenOf(s.payload)),
    row: {
      patientId: s.patientId,
      generation: s.generation,
      issuedAt: s.issuedAt,
      supersededAt: s.supersededAt ?? null,
      voidedAt: s.voidedAt ?? null,
    } satisfies WristbandRow,
  }));
  return {
    async patientReadable(_org, patientId) {
      return !unreadable.includes(patientId);
    },
    async patientState(org, patientId) {
      const mine = rows.filter((r) => r.org === org && r.row.patientId === patientId);
      return {
        hasAny: mine.length > 0,
        hasActive: mine.some((r) => r.row.supersededAt === null && r.row.voidedAt === null),
      };
    },
    async findByDigest(org, digest) {
      return rows.find((r) => r.org === org && r.digest === digest)?.row ?? null;
    },
  };
}

const verifierOf = (seeds: readonly Seed[], unreadable: readonly string[] = []) =>
  createWristbandVerifier(storeOf(seeds, unreadable), () => NOW);

const ACTIVE_A = payloadOf(1);
const ACTIVE_B = payloadOf(2);
const BASE: readonly Seed[] = [
  { patientId: PAT_A, payload: ACTIVE_A, generation: 1, issuedAt: hoursAgo(5) },
  { patientId: PAT_B, payload: ACTIVE_B, generation: 1, issuedAt: hoursAgo(5) },
];
const online = (payload: string | null, patientId = PAT_A) => ({
  organizationId: ORG,
  patientId,
  payload,
  asOf: NOW.toISOString(),
  mode: "online" as const,
});

describe("wristbandDigest", () => {
  it("is 64 hex chars, deterministic and org-salted", () => {
    const t = tokenOf(ACTIVE_A);
    expect(wristbandDigest(ORG, t)).toMatch(/^[0-9a-f]{64}$/);
    expect(wristbandDigest(ORG, t)).toBe(wristbandDigest(ORG, t));
    expect(wristbandDigest(ORG, t)).not.toBe(wristbandDigest(OTHER_ORG, t));
    expect(wristbandDigest(ORG, t)).not.toContain(t);
  });
});

describe("PatientWristbandVerifier -- online", () => {
  it("verifies the patient's own active band and reports the digest + generation", async () => {
    const v = await verifierOf(BASE).verify(online(ACTIVE_A));
    expect(v).toEqual({
      status: "verified",
      generation: 1,
      scannedDigest: wristbandDigest(ORG, tokenOf(ACTIVE_A)),
      matchedPatientId: null,
    });
  });

  it("accepts a keyboard-wedge CR/LF suffix and a typed lower-case fallback", async () => {
    expect((await verifierOf(BASE).verify(online(`${ACTIVE_A}\r\n`))).status).toBe("verified");
    expect((await verifierOf(BASE).verify(online(ACTIVE_A.toLowerCase()))).status).toBe("verified");
  });

  it("reports another patient's band as mismatch and names that patient", async () => {
    const v = await verifierOf(BASE).verify(online(ACTIVE_B, PAT_A));
    expect(v.status).toBe("mismatch");
    expect(v.matchedPatientId).toBe(PAT_B);
  });

  it("an unknown but well-formed token is a mismatch for a patient who has a band, never verified", async () => {
    const v = await verifierOf(BASE).verify(online(payloadOf(99)));
    expect(v.status).toBe("mismatch");
    expect(v.matchedPatientId).toBeNull();
  });

  it("no band presented: not_presented when one is on file, not_on_file when none is", async () => {
    expect((await verifierOf(BASE).verify(online(null))).status).toBe("not_presented");
    expect((await verifierOf([]).verify(online(null))).status).toBe("not_on_file");
  });

  it("a patient with no band on file cannot verify any token", async () => {
    const v = await verifierOf([BASE[1] as Seed]).verify(online(payloadOf(99)));
    expect(v.status).toBe("not_on_file");
  });

  it("malformed and checksum-damaged payloads are malformed with no digest", async () => {
    for (const raw of ["sha256:patient-a", "", `${ACTIVE_A.slice(0, -4)}0000`]) {
      const v = await verifierOf(BASE).verify(online(raw));
      expect(v).toEqual({
        status: "malformed",
        generation: null,
        scannedDigest: null,
        matchedPatientId: null,
      });
    }
  });

  it("a superseded band is refused online (a reprint kills the old band)", async () => {
    const seeds: Seed[] = [
      {
        patientId: PAT_A,
        payload: ACTIVE_A,
        generation: 1,
        issuedAt: hoursAgo(5),
        supersededAt: hoursAgo(1),
      },
      { patientId: PAT_A, payload: payloadOf(3), generation: 2, issuedAt: hoursAgo(1) },
    ];
    const v = await verifierOf(seeds).verify(online(ACTIVE_A));
    expect(v.status).toBe("superseded");
    expect(v.generation).toBe(1);
    expect((await verifierOf(seeds).verify(online(payloadOf(3)))).status).toBe("verified");
  });

  it("a voided band never verifies", async () => {
    const seeds: Seed[] = [
      {
        patientId: PAT_A,
        payload: ACTIVE_A,
        generation: 1,
        issuedAt: hoursAgo(5),
        voidedAt: hoursAgo(1),
      },
    ];
    expect((await verifierOf(seeds).verify(online(ACTIVE_A))).status).toBe("voided");
  });

  it("a patient unreadable under RLS (unknown / cross-tenant) is not_on_file, even for a real band", async () => {
    const v = await verifierOf(BASE, [PAT_A]).verify(online(ACTIVE_A));
    expect(v.status).toBe("not_on_file");
  });

  it("a digest from another tenant never matches (org salt)", async () => {
    const seeds: Seed[] = [
      { org: OTHER_ORG, patientId: PAT_B, payload: ACTIVE_B, generation: 1, issuedAt: hoursAgo(5) },
      { patientId: PAT_A, payload: ACTIVE_A, generation: 1, issuedAt: hoursAgo(5) },
    ];
    const v = await verifierOf(seeds).verify(online(ACTIVE_B));
    expect(v.status).toBe("mismatch");
    expect(v.matchedPatientId).toBeNull();
  });
});

describe("PatientWristbandVerifier -- offline_sync grace", () => {
  const SUPERSEDED_AT = hoursAgo(10);
  const seeds: readonly Seed[] = [
    {
      patientId: PAT_A,
      payload: ACTIVE_A,
      generation: 1,
      issuedAt: hoursAgo(30),
      supersededAt: SUPERSEDED_AT,
    },
    { patientId: PAT_A, payload: payloadOf(3), generation: 2, issuedAt: SUPERSEDED_AT },
  ];
  const offline = (asOf: Date, payload = ACTIVE_A) => ({
    organizationId: ORG,
    patientId: PAT_A,
    payload,
    asOf: asOf.toISOString(),
    mode: "offline_sync" as const,
  });

  it("a scan taken while the band was active still verifies after it was superseded", async () => {
    expect((await verifierOf(seeds).verify(offline(hoursAgo(12)))).status).toBe("verified");
  });

  it("the window is closed on both edges: before issue and after supersession are refused", async () => {
    expect((await verifierOf(seeds).verify(offline(hoursAgo(31)))).status).toBe("superseded");
    expect(
      (await verifierOf(seeds).verify(offline(new Date(SUPERSEDED_AT.getTime() + 1)))).status,
    ).toBe("superseded");
    expect((await verifierOf(seeds).verify(offline(SUPERSEDED_AT))).status).toBe("verified");
  });

  it("a scan older than 72 h at sync is refused, exactly 72 h is still allowed", async () => {
    const longLived: Seed[] = [
      {
        patientId: PAT_A,
        payload: ACTIVE_A,
        generation: 1,
        issuedAt: hoursAgo(200),
        supersededAt: hoursAgo(1),
      },
    ];
    const edge = new Date(NOW.getTime() - OFFLINE_WRISTBAND_MAX_AGE_MS);
    expect((await verifierOf(longLived).verify(offline(edge))).status).toBe("verified");
    expect((await verifierOf(longLived).verify(offline(new Date(edge.getTime() - 1)))).status).toBe(
      "superseded",
    );
  });

  it("a voided generation never verifies offline", async () => {
    const voided: Seed[] = [
      {
        patientId: PAT_A,
        payload: ACTIVE_A,
        generation: 1,
        issuedAt: hoursAgo(30),
        supersededAt: SUPERSEDED_AT,
        voidedAt: hoursAgo(2),
      },
    ];
    expect((await verifierOf(voided).verify(offline(hoursAgo(12)))).status).toBe("voided");
  });

  it("an offline asOf in the future cannot resurrect a superseded band", async () => {
    expect((await verifierOf(seeds).verify(offline(new Date(NOW.getTime() + 60_000)))).status).toBe(
      "superseded",
    );
  });

  it("another patient's band is still a mismatch offline", async () => {
    const v = await verifierOf([...seeds, ...BASE.slice(1)]).verify(
      offline(hoursAgo(12), ACTIVE_B),
    );
    expect(v.status).toBe("mismatch");
  });
});
