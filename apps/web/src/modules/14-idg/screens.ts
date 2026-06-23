// apps/web/src/modules/14-idg — M14 IDG screen registration (Track B, ADR-0030, M14-T07).
// The §5 IDG read screens that have a backing M14 read route on the generated client: the IDG Schedule
// (per-location), the pre-meeting Meeting Detail, the Live Meeting Surface, the per-patient Packet (chart
// embed), My Action Items, and the per-meeting Minutes. Nav visibility is gated by the matching M14 permission
// key; the SERVER stays the only enforcement point (no frontend authz, ADR-0030 — out-of-scope resources 404,
// never 403; SUD-flagged packet blocks redacted server-side per §7.2/W-SUD-01). The decision-recording panel,
// attendance tracker, action-item assignment, adjourn control (D13 fresh step-up), build-packets, and the
// minutes amendment-request write surfaces — plus the Socket.IO real-time decision/action-item propagation and
// the Capacitor Mobile Live variant — fill in as those write paths harden. The M22 minutes/packet PDF render and
// the M28 FHIR CareTeam/Encounter projection are deferred (Wave F/H handshakes).
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { IdgSchedule } from "./idg-schedule";
import { LiveMeeting } from "./live-meeting";
import { MeetingDetail } from "./meeting-detail";
import { Minutes } from "./minutes";
import { MyActionItems } from "./my-action-items";
import { PatientPacket } from "./patient-packet";

export const idgScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 14,
  slug: "14-idg",
  screens: [
    {
      // IDG Schedule — the coordinator's per-location landing surface (location from `?location=`).
      id: "idg.schedule",
      path: "/idg/schedule",
      title: "IDG Schedule",
      navGroup: "Clinical",
      requiredPermission: "idg.read",
      screen: IdgSchedule,
    },
    {
      // Meeting Detail (pre-meeting) — packet readiness + lifecycle; reached from the schedule.
      id: "idg.meeting-detail",
      path: "/idg/meetings/:id",
      title: "IDG Meeting",
      requiredPermission: "idg.read",
      screen: MeetingDetail,
    },
    {
      // Live Meeting Surface — patient list + lifecycle; reached from the meeting detail.
      id: "idg.meeting-live",
      path: "/idg/meetings/:id/live",
      title: "Live IDG Meeting",
      requiredPermission: "idg.read",
      screen: LiveMeeting,
    },
    {
      // Per-Patient Packet (chart embed) — read-only packet digest; param path (no nav).
      id: "idg.packet",
      path: "/idg/meetings/:meetingId/packets/:patientId",
      title: "IDG Packet",
      requiredPermission: "idg.read",
      screen: PatientPacket,
    },
    {
      // My Action Items — the caller's IDG action-item queue (`assignee=me` server-resolved).
      id: "idg.action-items",
      path: "/idg/action-items",
      title: "My Action Items",
      navGroup: "Clinical",
      requiredPermission: "idg.read",
      screen: MyActionItems,
    },
    {
      // Minutes (per meeting) — finalized/in-progress minutes; param path (no nav).
      id: "idg.minutes",
      path: "/idg/meetings/:id/minutes",
      title: "IDG Minutes",
      requiredPermission: "idg.read",
      screen: Minutes,
    },
  ],
};
