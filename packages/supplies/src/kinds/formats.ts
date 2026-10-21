// @chartwarden/supplies — TypeBox string-format registration for the §2.1 per-kind schemas.
//
// TypeBox's `Value` checker treats an UNREGISTERED format as a hard failure ("Unknown format 'uuid'"), not
// as a no-op — so a package that declares `format: 'uuid'` and never registers the checker rejects every
// payload, including the valid ones. Registered here (idempotently, mirroring the M13 / M22 route-TypeBox
// precedent) so `validateSupplyRequestData` behaves identically whether it is called from a route, a
// consumer or a unit test.
//
// The registry is process-global, so `Has` is checked before `Set`: whoever registered first wins and the
// two definitions must stay compatible. They are — both are the same RFC-4122 / `Date.parse` pair.

import { FormatRegistry } from "@sinclair/typebox";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
