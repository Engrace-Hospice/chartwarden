// @wardenx/saas-tenant-platform · consumers barrel (M34 §7.3 / §4.5).
//
// M34's outbox-subscription surface — the consumers that handle events OTHER modules emit. Today this is
// the single M22 §1.1-handshake back-ref consumer: M22 replies `m22.document.rendered` after rendering
// the DSAR Bundle PDF + NDJSON manifest, and `decideDsarBackRef` / `applyDsarBackRef` write the resulting
// `document_id` onto `dsar_export_job.bundle_document_id`. Every consumed event is read SOLELY through the
// foundation outbox event STRING — no producer-package import, no new manifest `dependsOn` edge.
export {
  type DsarBackRefAction,
  type DsarBackRefFacts,
  type M22DocumentRenderedPayload,
  M22_DOCUMENT_RENDERED,
  M34_DSAR_BACKREF_SUBSCRIPTION,
  applyDsarBackRef,
  decideDsarBackRef,
} from "./m22-document-backref";
