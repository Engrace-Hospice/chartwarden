import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  fileURLToPath(new URL("../1495_m25_835_group_scoped_identity.sql", import.meta.url)),
  "utf8",
);

describe("M25-671-B migration 1495 identity uniqueness", () => {
  it("retains all-null historical identities and requires complete provenance for new identities", () => {
    expect(SQL.match(/IS NULL AND/g)).toHaveLength(4);
    expect(SQL).toContain("remittance_advice_group_identity_complete CHECK");
    expect(SQL).toContain("claimmd_era_m25_stage_group_identity_complete CHECK");
  });

  it("makes NULL provenance participate in uniqueness instead of bypassing deduplication", () => {
    expect(SQL).toContain("UNIQUE NULLS NOT DISTINCT (source_inbox_id, file_index");
    expect(SQL).toMatch(/CREATE UNIQUE INDEX ux_remittance_envelope_dedupe[\s\S]*?NULLS NOT DISTINCT;/);
  });

  it("keeps tenant, provider, ISA partner, ISA13, GS06, and ST02 in the remittance key", () => {
    expect(SQL).toMatch(
      /ON remittance_advice \(organization_id, provider_entity_id, interchange_control_number,\s*interchange_sender_code, interchange_receiver_code,\s*functional_group_control_number, transaction_set_control_number\)/,
    );
    expect(SQL).toContain("DROP INDEX IF EXISTS ux_remittance_envelope_dedupe");
    expect(SQL).toContain("-- compat: contract");
  });
});
