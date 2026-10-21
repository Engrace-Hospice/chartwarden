// @chartwarden/db — Module 29 (External Interfaces) schema barrel: the eleven `ownedTables`
// `architecture/module-manifest.ts` gives M29 (§3.3).
//
// TENANT-SCOPED (nine) — organization_id NOT NULL, RLS keyed ONLY on app.org_id (§3.5):
//   external_feed · external_feed_credential · external_feed_health · hl7_message_inbound ·
//   hl7_message_outbound · hl7_inbound_proposal · lab_observation · lab_observation_value ·
//   lab_observation_inbound_link
//
// PLATFORM-SHARED (two) — nppes_provider · nppes_sync_run, no organization_id: the public CMS directory is
// the same for every tenant, so read-all `USING (true)` to chartwarden_app, writes only via chartwarden_admin.
//
// FIVE ARE PARTITIONED MONTHLY (§3.2 Phase B) and carry composite primary keys declared in SQL:
//   hl7_message_inbound (received_at) · lab_observation (received_at) · lab_observation_value (received_at)
//   in migration 0145; hl7_message_outbound (queued_at) in 0146; hl7_inbound_proposal (proposed_at) in
//   0147. RLS/grants + the M4 write-audit triggers land in 0148. Enums in ./enums (0144 Phase A).
export * from "./enums";
export * from "./feed";
export * from "./feed-health";
export * from "./feed-listener-state";
export * from "./hl7-messages";
export * from "./inbound-proposal";
export * from "./lab-observation";
export * from "./nppes";
