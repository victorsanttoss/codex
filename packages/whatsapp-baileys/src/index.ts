export { BaileysChannelProvider, BAILEYS_ADAPTER_KEY, type BaileysChannelConfig } from "./baileys-adapter";
export { BaileysSendError } from "./errors";
export {
  jidToPhone,
  phoneToJid,
  buildInboundEnvelope,
  buildStatusEnvelope,
  type BaileysInboundEnvelope,
  type BaileysStatusEnvelope,
} from "./envelope";
export {
  type BaileysDriver,
  type BaileysConnection,
  type BaileysSendOptions,
  type BaileysOpenOptions,
  type BaileysEvent,
  type BaileysConnState,
  type BaileysInboundRaw,
  type BaileysStatusRaw,
  type BaileysAuthState,
  FakeBaileysDriver,
  FakeBaileysConnection,
} from "./driver";
export { RealBaileysDriver, makeDebouncedPersist, restoreAuth } from "./real-driver";
