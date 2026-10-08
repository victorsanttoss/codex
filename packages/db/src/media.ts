import { and, desc, eq, isNotNull } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { mediaObjects } from "./schema";

export interface MediaObjectInput {
  messageId: string;
  providerMediaId: string;
  mimeType?: string;
  storageRef?: string;
  sha256?: string;
  size?: number;
  downloadedAt?: Date;
}

/** Persiste uma mídia baixada (Media API). storage_ref é abstrato (local/S3). */
export async function insertMediaObject(input: MediaObjectInput): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const [row] = await tx
      .insert(mediaObjects)
      .values({
        tenantId,
        messageId: input.messageId,
        providerMediaId: input.providerMediaId,
        mimeType: input.mimeType ?? null,
        storageRef: input.storageRef ?? null,
        sha256: input.sha256 ?? null,
        size: input.size ?? null,
        downloadedAt: input.downloadedAt ?? null,
      })
      .returning({ id: mediaObjects.id });
    if (!row) throw new Error("falha ao inserir media_object");
    return { id: row.id };
  });
}

export interface CachedTranscription {
  text: string;
  seconds: number | null;
}

/**
 * Cache de transcrição por mídia (idempotência): devolve a transcrição já
 * persistida para o `providerMediaId` do tenant, se houver. Garante que um retry
 * do mesmo áudio NÃO re-transcreva nem re-cobre. RLS isola por tenant.
 */
export async function getTranscriptionByMedia(
  providerMediaId: string,
): Promise<CachedTranscription | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const [row] = await tx
      .select({ text: mediaObjects.transcription, seconds: mediaObjects.transcriptionSeconds })
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.tenantId, tenantId),
          eq(mediaObjects.providerMediaId, providerMediaId),
          isNotNull(mediaObjects.transcription),
        ),
      )
      .orderBy(desc(mediaObjects.transcribedAt))
      .limit(1);
    if (!row || row.text == null) return null;
    return { text: row.text, seconds: row.seconds ?? null };
  });
}

/** Persiste a transcrição na media_object (vinculada à message). */
export async function saveTranscription(
  mediaObjectId: string,
  text: string,
  seconds: number | null,
  transcribedAt: Date,
): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(mediaObjects)
      .set({ transcription: text, transcriptionSeconds: seconds, transcribedAt })
      .where(and(eq(mediaObjects.id, mediaObjectId), eq(mediaObjects.tenantId, tenantId)));
  });
}
