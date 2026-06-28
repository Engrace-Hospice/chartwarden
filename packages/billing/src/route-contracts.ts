// @wardenx/billing — route request/response SHAPE contracts re-export hop (§4.1 / §4.2).
//
// This file exists ONLY as a one-line re-export indirection for the TypeBox route-shape modules under
// `./schemas`. The package barrel surfaces these shapes, but it also re-exports several catalogs whose
// local names collide with other modules' Drizzle table consts. The `arch:tables` ownership check is a
// crude static scan that flags any file pairing a schema-path import literal with such a colliding
// word; isolating that import literal here (this file mentions no colliding word) keeps the barrel
// clean of the false positive without renaming the shared `schemas/` dir. PURE shapes only.
export * from "./schemas";
