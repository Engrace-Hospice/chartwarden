import { describe, expect, it } from "vitest";
import {
  type TenantStorageReconcilePort,
  reconcileTenantStorage,
} from "../storage/reconcile-tenant-storage";

const silentLog = {
  log() {},
  error() {},
};

describe("reconcileTenantStorage", () => {
  it("creates missing tenant buckets and leaves existing buckets intact", async () => {
    const calls: string[] = [];
    const port: TenantStorageReconcilePort = {
      async listTenantOrganizationIds() {
        return ["org-a", "org-b"];
      },
      async ensureTenantPrefixes(input) {
        calls.push(`${input.organizationId}:${input.prefixes.join(",")}`);
        return {
          bucket: `tenant-${input.organizationId}`,
          created: input.organizationId === "org-a",
        };
      },
    };

    await expect(reconcileTenantStorage(port, silentLog)).resolves.toEqual({
      created: ["tenant-org-a"],
      existing: ["tenant-org-b"],
      errors: [],
    });
    expect(calls).toEqual([
      "org-a:documents,generated,intake,claims,cost-reports,exports",
      "org-b:documents,generated,intake,claims,cost-reports,exports",
    ]);
  });

  it("continues across tenants and reports explicit per-organization errors", async () => {
    const port: TenantStorageReconcilePort = {
      async listTenantOrganizationIds() {
        return ["org-a", "org-b", "org-c"];
      },
      async ensureTenantPrefixes(input) {
        if (input.organizationId === "org-b") throw new Error("minio denied");
        return { bucket: `tenant-${input.organizationId}`, created: false };
      },
    };

    await expect(reconcileTenantStorage(port, silentLog)).resolves.toEqual({
      created: [],
      existing: ["tenant-org-a", "tenant-org-c"],
      errors: [{ organizationId: "org-b", error: "minio denied" }],
    });
  });
});
