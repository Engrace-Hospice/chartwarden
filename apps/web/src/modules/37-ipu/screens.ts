// apps/web/src/modules/37-ipu — M37 IPU Management screen registration (§5, ADR-0030). The tenant-facing
// IPU screens under an "IPU" navGroup at /ipu/*. Each `requiredPermission` is a REAL §4.6 M37 key the
// matching read route gates on (M37_CONTRIBUTED_PERMISSIONS in @wardenx/auth) — the server stays the
// authoritative enforcer, this only gates nav visibility.
//
// #91 — the bedside pane has landed, which is what this header used to promise ("the deeper bedside /
// restraint / visitor detail panes extend this registry as they land"). It is a param-path detail
// screen reached from an admissions row, so it carries no `navGroup`.
//
// It gates on `m37.ipu_admission.read`, the same key its four sub-resource reads gate on server-side.
// That is deliberate and matches #169: no role template grants a permission key that does not exist, so
// minting `m37.restraint.read` and friends would have hidden this screen from every caller and denied
// its reads to every one of them — the fail-closed invisibility this whole audit is about. Which
// templates get a narrower key is a tenant policy decision, taken deliberately or not at all.
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
const IpuBedside = lazy(() => import("./ipu-bedside").then((m) => ({ default: m.IpuBedside })));

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
      // Detail screen — reached from an admissions row; omitted from nav (param path).
      id: "ipu.bedside",
      path: "/ipu/admissions/:id",
      title: "Bedside",
      requiredPermission: "m37.ipu_admission.read",
      screen: IpuBedside,
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
