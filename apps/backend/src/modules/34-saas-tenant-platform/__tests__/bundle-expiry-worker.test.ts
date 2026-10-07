// GAP-163 — the nightly `tenant.bundle_expiry_sweep` is bound over the DSAR + tenant-export repositories and the
// object-store destroy: a bundle past its 7-day TTL has its object destroyed, its handles cleared and a
// `bundle_expired_reaped` event appended; a failing org never starves the others.
import { describe, expect, it, vi } from "vitest";
import {
  type BundleExpiryRepos,
  buildBundleExpiryPorts,
  runBundleExpiryForAllOrgs,
} from "../jobs/bundle-expiry-worker";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-10T00:00:00Z");
const PAST = new Date("2026-10-01T00:00:00Z");
const FUTURE = new Date("2026-10-20T00:00:00Z");

function fakeRepos(): BundleExpiryRepos & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    dsar: {
      listByPresignedExpiry: async () => [
        {
          id: "d1",
          bundleMinioObjectKey: "exports/dsar/d1.ndjson.gz",
          bundlePresignedUrlExpiresAt: PAST,
        },
        {
          id: "d2",
          bundleMinioObjectKey: "exports/dsar/d2.ndjson.gz",
          bundlePresignedUrlExpiresAt: FUTURE,
        },
      ],
      update: async (id) => {
        calls.push(`dsar.update:${id}`);
      },
      appendEvent: async (v) => {
        calls.push(`dsar.event:${v.dsarExportJobId}:${v.eventKind}`);
      },
    },
    tenantExport: {
      listByPresignedExpiry: async () => [
        { id: "t1", bundleMinioObjectKey: null, bundlePresignedUrlExpiresAt: PAST },
      ],
      update: async (id) => {
        calls.push(`tenant.update:${id}`);
      },
      appendEvent: async (v) => {
        calls.push(`tenant.event:${v.tenantExportJobId}:${v.eventKind}`);
      },
    },
  };
}

describe("buildBundleExpiryPorts", () => {
  it("tags both families, destroys only expired objects, clears handles and records the reap", async () => {
    const repos = fakeRepos();
    const destroy = vi.fn(async () => undefined);
    const ports = buildBundleExpiryPorts({
      organizationId: ORG_A,
      repos,
      destroyObject: destroy,
      now: () => NOW,
    });

    const listed = await ports.listExpiringBundles();
    expect(listed.map((b) => `${b.kind}:${b.jobId}`)).toEqual([
      "dsar:d1",
      "dsar:d2",
      "tenant_export:t1",
    ]);

    await ports.deleteBundleObject("dsar", "exports/dsar/d1.ndjson.gz");
    expect(destroy).toHaveBeenCalledWith({
      organizationId: ORG_A,
      objectKey: "exports/dsar/d1.ndjson.gz",
    });

    await ports.clearBundleArtifact("dsar", "d1");
    await ports.recordReapEvent("tenant_export", "t1");
    expect(repos.calls).toEqual(["dsar.update:d1", "tenant.event:t1:bundle_expired_reaped"]);
  });
});

describe("runBundleExpiryForAllOrgs", () => {
  it("sweeps every active org and survives one org failing", async () => {
    const warn = vi.fn();
    const result = await runBundleExpiryForAllOrgs({
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      sweepOrg: async (organizationId) => {
        if (organizationId === ORG_A) throw new Error("minio down");
        return {
          scanned: 2,
          reaped: [{ jobId: "x", kind: "dsar", objectDeleted: true }],
          objectsDeleted: 1,
        };
      },
      warn,
    });
    expect(result).toEqual({ orgs: 2, reaped: 1, failedOrgs: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
