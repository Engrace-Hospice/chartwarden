// WP 4.6 (ADR-0073) - the pieces that must agree across packages without a database: the designated event types in
// @chartwarden/messaging are the event constants the backend emits, the flag gate needs BOTH the policy flag and the event's family flag,
// the seeded rules for the designated events stay in-app only (the out-of-band routes come from code, not data), and migration 1123 keeps
// its structural promises (tenant-scoped through active membership, channel names only, owner and grants).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DESIGNATED_EVENT_TYPES, PLATFORM_DEFAULT_ALERT_RULES } from "@chartwarden/messaging";
import {
  ACK_REQUESTS_FLAG_KEY,
  NOTIFICATION_POLICY_FLAG_KEY,
  URGENT_CLINICAL_FLAG_KEY,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  M36_ACK_ESCALATED,
  M36_ACK_REASSIGNED,
  M36_ACK_REQUESTED,
} from "../src/modules/36-messaging/ack-requests/ack-events";
import { policyFlagsAllow } from "../src/modules/36-messaging/notification-policy-ports";
import { M36_URGENT_MESSAGE_SENT } from "../src/modules/36-messaging/urgent/urgent-events";

const sql = readFileSync(
  join(
    __dirname,
    "../../../packages/db/migrations/1123_m36_notification_policy_endpoint_reader.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("WP 4.6 notification policy wiring", () => {
  it("the designated event types are exactly the four assignee-facing request events the backend emits", () => {
    expect([...DESIGNATED_EVENT_TYPES].sort()).toEqual(
      [M36_URGENT_MESSAGE_SENT, M36_ACK_REQUESTED, M36_ACK_REASSIGNED, M36_ACK_ESCALATED].sort(),
    );
  });

  it("every designated event keeps a seeded rule that is in-app only (the out-of-band route is the code's, not a tenant-editable row's)", () => {
    for (const eventType of DESIGNATED_EVENT_TYPES) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
      expect(rule, eventType).toBeDefined();
      expect(rule?.channelsOverride).toEqual(["in_app"]);
    }
  });

  it("the flag gate needs the policy flag AND the event's family flag, and absent means off", () => {
    expect(policyFlagsAllow({}, M36_ACK_REQUESTED)).toBe(false);
    expect(policyFlagsAllow({ [NOTIFICATION_POLICY_FLAG_KEY]: true }, M36_ACK_REQUESTED)).toBe(
      false,
    );
    expect(policyFlagsAllow({ [ACK_REQUESTS_FLAG_KEY]: true }, M36_ACK_REQUESTED)).toBe(false);
    const both = { [NOTIFICATION_POLICY_FLAG_KEY]: true, [ACK_REQUESTS_FLAG_KEY]: true };
    expect(policyFlagsAllow(both, M36_ACK_ESCALATED)).toBe(true);
    // urgent_sent is gated by urgent_clinical, not ack_requests.
    expect(policyFlagsAllow(both, M36_URGENT_MESSAGE_SENT)).toBe(false);
    expect(
      policyFlagsAllow(
        { [NOTIFICATION_POLICY_FLAG_KEY]: true, [URGENT_CLINICAL_FLAG_KEY]: true },
        M36_URGENT_MESSAGE_SENT,
      ),
    ).toBe(true);
    expect(
      policyFlagsAllow(
        { [NOTIFICATION_POLICY_FLAG_KEY]: "yes" as never, [ACK_REQUESTS_FLAG_KEY]: true },
        M36_ACK_REQUESTED,
      ),
    ).toBe(false);
  });

  it("migration 1123: security definer, tenant-scoped by active membership, channel names only, owned and granted narrowly", () => {
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog, public");
    expect(sql).toContain("m.organization_id = p_organization_id AND m.status = 'active'");
    expect(sql).toContain(
      "p_organization_id = nullif(current_setting('app.org_id', true), '')::uuid",
    );
    expect(sql).toContain("jsonb_array_length(p_user_ids) > 500");
    expect(sql).toContain("e.verification_status = 'verified'");
    expect(sql).toContain("RETURNS TABLE (user_id uuid, channel text)");
    expect(sql).not.toContain("endpoint_value");
    expect(sql).toContain("OWNER TO wardenx_admin");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION delivery_endpoint_verified_channels_for_org_users(uuid, jsonb) FROM PUBLIC",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION delivery_endpoint_verified_channels_for_org_users(uuid, jsonb) TO wardenx_app",
    );
  });
});
