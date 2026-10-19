/**
 * M36-T07 — Module 36 permission-key registration into Module 3's catalog (the §4.5 binding
 * cross-module handshake). M36's messaging/notification/alert-rule routes are authorized BY M3,
 * so their permission keys must live in M3's catalog and mirror to the DB `permission` table.
 *
 * Accept (M36-T07): the ten §4.5 keys are registered, single-owner, and namespaced under
 * `messaging.` / `notifications.` / `alert.`; read/send/manage_members carry the
 * `channel_visibility` ABAC predicate, the rest are pure RBAC; the keys do not collide with M3's
 * locked catalog or the M1/M2/M4/M38 contributed sets; and they all flow into the consolidated
 * `allPermissionMirrorRows()` projection without breaking key uniqueness.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTED_PERMISSIONS,
  M4_CONTRIBUTED_PERMISSIONS,
  M36_CONTRIBUTED_PERMISSIONS,
  M38_CONTRIBUTED_PERMISSIONS,
  PERMISSIONS,
  allPermissionMirrorRows,
  m36ContributedPermissionMirrorRows,
} from "../src/permissions";

describe("M36-T07 messaging permission keys (§4.5 handshake)", () => {
  it("registers exactly the ten §4.5 keys plus the WP 2.8 template manager, the WP 2.7b global search manager and the WP 3.7 chart-promotion request key", () => {
    expect(Object.keys(M36_CONTRIBUTED_PERMISSIONS).sort()).toEqual(
      [
        "messaging.read",
        "messaging.send",
        "messaging.dm",
        "messaging.manage_members",
        "messaging.announce",
        "notifications.preferences.manage",
        "notifications.endpoint.manage",
        "alert.rules.read",
        "alert.rules.manage",
        "messaging.admin.read",
        "messaging.template.manage",
        "messaging.global_search.manage",
        "messaging.promote",
        "messaging.review",
        "messaging.urgent.send",
        "messaging.urgent.receive",
        "messaging.oncall.read",
        "messaging.oncall.send",
        "messaging.sessions.manage",
        "alert.inbox.self",
      ].sort(),
    );
  });

  it("every key is namespaced and dot-segmented", () => {
    for (const key of Object.keys(M36_CONTRIBUTED_PERMISSIONS)) {
      expect(key).toMatch(/^(messaging|notifications|alert)\.[a-z_]+(\.[a-z_]+)*$/);
    }
  });

  it("read/send/manage_members ride the channel_visibility predicate; the rest are pure RBAC", () => {
    expect(M36_CONTRIBUTED_PERMISSIONS["messaging.read"].abac).toBe("channel_visibility");
    expect(M36_CONTRIBUTED_PERMISSIONS["messaging.send"].abac).toBe("channel_visibility");
    expect(M36_CONTRIBUTED_PERMISSIONS["messaging.manage_members"].abac).toBe("channel_visibility");
    for (const key of [
      "messaging.dm",
      "messaging.announce",
      "notifications.preferences.manage",
      "notifications.endpoint.manage",
      "alert.rules.read",
      "alert.rules.manage",
      "messaging.admin.read",
      "messaging.template.manage",
      "messaging.global_search.manage",
      "messaging.promote",
      "messaging.review",
      "messaging.oncall.read",
      "messaging.oncall.send",
      "messaging.sessions.manage",
      "alert.inbox.self",
    ] as const) {
      expect(M36_CONTRIBUTED_PERMISSIONS[key].abac).toBe("none");
    }
  });

  it("the admin key is platform-category; alert-rule edits are admin", () => {
    expect(M36_CONTRIBUTED_PERMISSIONS["messaging.admin.read"].category).toBe("platform");
    expect(M36_CONTRIBUTED_PERMISSIONS["alert.rules.read"].category).toBe("admin");
    expect(M36_CONTRIBUTED_PERMISSIONS["alert.rules.manage"].category).toBe("admin");
  });

  it("does NOT collide with M3's locked catalog or the M1/M2/M4/M38 contributed sets (single-owner)", () => {
    for (const key of Object.keys(M36_CONTRIBUTED_PERMISSIONS)) {
      expect(key in PERMISSIONS).toBe(false);
      expect(key in CONTRIBUTED_PERMISSIONS).toBe(false);
      expect(key in M4_CONTRIBUTED_PERMISSIONS).toBe(false);
      expect(key in M38_CONTRIBUTED_PERMISSIONS).toBe(false);
    }
  });

  it("projects one mirror row per M36 key for the DB `permission` table sync", () => {
    const rows = m36ContributedPermissionMirrorRows();
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(M36_CONTRIBUTED_PERMISSIONS).sort());
    for (const row of rows) {
      const def = M36_CONTRIBUTED_PERMISSIONS[row.key as keyof typeof M36_CONTRIBUTED_PERMISSIONS];
      expect(row.defaultAbac).toBe(def.abac);
      expect(row.resource).toBe(def.resource);
      expect(row.action).toBe(def.action);
    }
  });

  it("flows into the consolidated mirror without breaking key uniqueness", () => {
    const keys = allPermissionMirrorRows().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of Object.keys(M36_CONTRIBUTED_PERMISSIONS)) {
      expect(keys).toContain(key);
    }
  });
});
