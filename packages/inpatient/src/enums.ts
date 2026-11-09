// @chartwarden/inpatient — M37 §3.2 enum value tuples. Each is `as const satisfies readonly <LeafUnion>[]`
// so the two definition sites (this package's runtime tuples and the packages/db pgEnums, both mirroring
// the packages/types leaf unions) cannot silently drift — the M30 "wire enum as Type.String is a silent
// lie" lesson. These tuples are the runtime source for TypeBox/`Type.Union(...map(Type.Literal))` DTOs
// and for exhaustive state-machine guards in the domain kernels (T03–T10).

