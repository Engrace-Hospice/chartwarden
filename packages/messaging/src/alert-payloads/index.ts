// @wardenx/messaging — Alert Payload Catalog (Foundation Registry + boot validation) barrel
// (M36-T05; spec §3.11–3.12). The typed alert-payload registry every later module contributes to
// at its own boot (no import edge into M36, M36-F01) and the boot gate M36 validates it with.
export {
  AlertPayloadCollisionError,
  buildAlertPayloadCatalog,
  validateAlertPayloadCatalog,
  assertAlertPayloadCatalogValid,
  isRegisteredPayloadType,
  alertPayloadCatalogRows,
  createAlertPayloadRegistry,
  type AlertPayloadCatalogViolation,
  type AlertPayloadRegistry,
} from "./registry";
