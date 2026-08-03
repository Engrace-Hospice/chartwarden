// apps/web/src/modules/37-ipu — M37 IPU Management screen registration (§5, ADR-0030). The tenant-facing
// IPU screens under an "IPU" navGroup at /ipu/*. Each `requiredPermission` is a REAL §4.6 M37 key the
// matching read route gates on (M37_CONTRIBUTED_PERMISSIONS in @wardenx/auth) — the server stays the
// authoritative enforcer, this only gates nav visibility. This is a focused core slice (units board,
// admissions worklist, daily census, equipment register); the deeper bedside / restraint / visitor detail
// panes extend this registry as they land.
import type { ScreenRegistryModule } from "@wardenx/types";
import { lazy } from "react";
import type { ComponentType } from "react";
const IpuAdmissions = lazy(() =>
  import("./ipu-admissions").then((m) => ({ default: m.IpuAdmissions })),
);
const IpuCensus = lazy(() => import("./ipu-census").then((m) => ({ default: m.IpuCensus })));
const IpuEquipment = lazy(() =>
  import("./ipu-equipment").then((m) => ({ default: m.IpuEquipment })),
);
const IpuUnits = lazy(() => import("./ipu-units").then((m) => ({ default: m.IpuUnits })));

export const ipuScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 37,
  slug: "37-ipu",
  screens: [
    {
      id: "ipu.units",
      path: "/ipu",
      title: "Inpatient units",
      navGroup: "IPU",
      requiredPermission: "m37.unit.read",
      screen: IpuUnits,
    },
    {
      id: "ipu.admissions",
      path: "/ipu/admissions",
      title: "IPU admissions",
      navGroup: "IPU",
      requiredPermission: "m37.ipu_admission.read",
      screen: IpuAdmissions,
    },
    {
      id: "ipu.census",
      path: "/ipu/census",
      title: "IPU census",
      navGroup: "IPU",
      requiredPermission: "m37.census.read",
      screen: IpuCensus,
    },
    {
      id: "ipu.equipment",
      path: "/ipu/equipment",
      title: "IPU equipment",
      navGroup: "IPU",
      requiredPermission: "m37.equipment.read",
      screen: IpuEquipment,
    },
  ],
};
