import type { ScreenRegistryModule } from "@wardenx/types";
// apps/admin/src/modules/01-ops — WX-PR-020 (OPS-004) operator recovery screens, registered into the
// M34 admin shell (the same registration pattern as apps/admin/src/modules/35-subscription-billing).
// `requiredPermission: "member.manage"` reuses the SAME admin-only bar Staff Management gates on — a
// pragmatic choice for a first, single-surface ops slice rather than minting a new `ops.*` permission
// category (see the backend route's own comment, apps/backend/src/bootstrap/routes/ops-outbox.ts).
import type { ComponentType } from "react";
import { OutboxDetail } from "./outbox-detail";
import { OutboxList } from "./outbox-list";

export const opsAdminScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 1,
  slug: "01-ops",
  screens: [
    {
      id: "admin.ops.outbox",
      path: "/admin/ops/outbox",
      title: "Outbox",
      navGroup: "Platform",
      requiredPermission: "member.manage",
      screen: OutboxList,
    },
    {
      id: "admin.ops.outbox-detail",
      path: "/admin/ops/outbox/:id",
      title: "Outbox event",
      navGroup: "Platform",
      requiredPermission: "member.manage",
      screen: OutboxDetail,
    },
  ],
};
