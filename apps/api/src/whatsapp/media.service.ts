import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import type { TenantSecretKind } from "@sdr/core";
import { insertMediaObject, makeCipherFromEnv, TenantSecretsStore } from "@sdr/db";
import type { HttpClient } from "@sdr/whatsapp-cloud";
import { APP_CONFIG } from "../config/config.module";
import { WHATSAPP_HTTP } from "./http.token";

/**
 * Baixa a mídia pela Media API (com o token do tenant) e persiste em
 * media_objects. storage_ref é abstrato (memory/local/S3 — pluggable). Roda
 * dentro do contexto de tenant.
 */
/** Teto de tamanho de mídia (defesa contra DoS). Streaming/storage real é M6. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024; // 16 MB

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(WHATSAPP_HTTP) private readonly http: HttpClient,
  ) {}

  /**
   * Baixa a mídia, persiste media_objects e DEVOLVE os bytes (p/ enriquecimento,
   * ex.: transcrição de áudio no M12 — sem re-download). Null em qualquer falha
   * (sem token, HTTP, tamanho) — a pipeline segue sem a mídia.
   */
  async downloadAndStore(
    messageId: string,
    mediaId: string,
    secretRef: TenantSecretKind,
  ): Promise<DownloadedMedia | null> {
    const token = await new TenantSecretsStore(makeCipherFromEnv()).get(secretRef);
    if (!token) {
      this.logger.warn(`Sem token para baixar mídia ${mediaId}`);
      return null;
    }
    const auth = { authorization: `Bearer ${token}` };
    const root = `${this.cfg.whatsapp.graphApiBase}/${this.cfg.whatsapp.graphApiVersion}`;

    const metaRes = await this.http.get(`${root}/${mediaId}`, { headers: auth });
    if (metaRes.status >= 300) {
      this.logger.warn(`Metadados de mídia ${mediaId}: HTTP ${metaRes.status}`);
      return null;
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!meta.url) return null;
    // Guard PRÉ-download: a Media API informa file_size — rejeita antes de baixar
    // os bytes (não materializa Buffer grande em memória numa VPS).
    const declaredSize = typeof meta.file_size === "number" ? meta.file_size : undefined;
    if (declaredSize !== undefined && declaredSize > MAX_MEDIA_BYTES) {
      this.logger.warn(`Mídia ${mediaId} declara ${declaredSize} bytes (> ${MAX_MEDIA_BYTES}) — descartada.`);
      return null;
    }

    const binRes = await this.http.get(meta.url, { headers: auth });
    if (binRes.status >= 300) return null;
    // Guard PRÉ-materialização (achado pentest): quando a Media API NÃO informa
    // file_size, o binário era lido INTEIRO (arrayBuffer) antes do check de 16MB.
    // Aqui checamos o Content-Length do binário ANTES de materializar. FAIL-CLOSED:
    // se não há tamanho declarado (nem file_size, nem Content-Length), descarta sem
    // ler tudo (mídia legítima do WhatsApp sempre traz ao menos um dos dois).
    const contentLength = parseSize(binRes.header?.("content-length"));
    const knownSize = declaredSize ?? contentLength;
    if (knownSize === undefined) {
      this.logger.warn(`Mídia ${mediaId} sem tamanho declarado (file_size/Content-Length) — descartada.`);
      return null;
    }
    if (knownSize > MAX_MEDIA_BYTES) {
      this.logger.warn(`Mídia ${mediaId} declara ${knownSize} bytes (> ${MAX_MEDIA_BYTES}) — descartada.`);
      return null;
    }
    const buf = Buffer.from(await binRes.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) {
      // Última linha: a rede mentiu no header/tamanho declarado.
      this.logger.warn(`Mídia ${mediaId} excede ${MAX_MEDIA_BYTES} bytes — descartada.`);
      return null;
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");

    const { id } = await insertMediaObject({
      messageId,
      providerMediaId: mediaId,
      ...(meta.mime_type ? { mimeType: meta.mime_type } : {}),
      sha256,
      size: buf.length,
      storageRef: `memory:${mediaId}`,
      downloadedAt: new Date(),
    });
    return { mediaObjectId: id, buffer: buf, ...(meta.mime_type ? { mimeType: meta.mime_type } : {}) };
  }
}

/** Interpreta um header Content-Length em bytes (undefined se ausente/ inválido). */
function parseSize(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Resultado do download: id persistido + bytes em memória + MIME (se houver). */
export interface DownloadedMedia {
  mediaObjectId: string;
  buffer: Buffer;
  mimeType?: string;
}
