// @wardenx/messaging — out-of-band dispatch + vendor-callback reconcile (M36 GAP-101; §4.4 / §4.7 / §4.9).
export {
  type FakeTransportCall,
  type OutOfBandTransport,
  type OutOfBandTransportChannel,
  type OutOfBandTransports,
  type TransportSendRequest,
  type TransportSendResult,
  TRANSPORT_NOT_CONFIGURED,
  TransportError,
  createDenyTransport,
  createDenyTransports,
  createFakeTransports,
} from "./transports";
export {
  DELIVERY_CLAIM_LEASE_MS,
  DELIVERY_SWEEP_BATCH_LIMIT,
  DELIVERY_SWEEP_INTERVAL_MS,
  backoffDelayMs,
  hasAttemptsLeft,
  queueParametersFor,
} from "./retry";
export {
  type ClaimedDelivery,
  type DispatchOutcome,
  type DispatchPorts,
  type ResolvedDestination,
  dispatchClaimedDelivery,
} from "./dispatch";
export {
  type VendorCallbackKind,
  type VendorTransition,
  canTransition,
  mapVendorStatus,
} from "./reconcile";
