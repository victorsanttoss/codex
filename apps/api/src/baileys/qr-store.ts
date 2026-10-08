import { Redis } from "ioredis";

/** Status de pareamento exposto ao onboarding (poll do painel). */
export interface PairingState {
  status: "qr" | "connected" | "logged_out" | "closed" | "connecting";
  /** QR (string) quando status='qr' — o painel renderiza. Some ao conectar. */
  qr?: string;
  updatedAt: string;
}

/**
 * Troca de QR/estado entre o SESSION-WORKER (que detém o socket) e o nó de API
 * (que mostra o QR no painel) — via Redis, com TTL curto. O QR é efêmero e não é
 * segredo persistente; ainda assim TTL evita retenção. NUNCA guarda credenciais.
 */
export interface QrStore {
  publish(tenantId: string, phoneNumberId: string, state: PairingState): Promise<void>;
  read(tenantId: string, phoneNumberId: string): Promise<PairingState | null>;
}

export const QR_STORE = "QR_STORE";

function key(tenantId: string, phoneNumberId: string): string {
  return `baileys:qr:${tenantId}:${phoneNumberId}`;
}

export class RedisQrStore implements QrStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async publish(tenantId: string, phoneNumberId: string, state: PairingState): Promise<void> {
    await this.redis.set(key(tenantId, phoneNumberId), JSON.stringify(state), "EX", this.ttlSeconds);
  }

  async read(tenantId: string, phoneNumberId: string): Promise<PairingState | null> {
    const raw = await this.redis.get(key(tenantId, phoneNumberId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PairingState;
    } catch {
      return null;
    }
  }
}
