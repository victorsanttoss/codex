import { and, eq } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { processedMessages } from "./schema";

/**
 * Idempotência de webhook (contrato item 8), em DUAS operações separadas:
 * `isMessageProcessed` (consultar) e `markMessageProcessed` (registrar). O
 * registro acontece APÓS o processamento com sucesso — assim uma falha
 * transitória (DB/LLM/envio) deixa a mensagem elegível para o retry do worker
 * (at-least-once, ADR 0024/0027). A concorrência dentro da janela é protegida
 * pelo FIFO-lock por conversa: o par consulta+registro roda sob o lock.
 */

/** Já processamos este (provider, external_message_id) no tenant ativo? */
export async function isMessageProcessed(
  provider: string,
  externalMessageId: string,
): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ id: processedMessages.id })
      .from(processedMessages)
      .where(
        and(
          eq(processedMessages.tenantId, tenantId),
          eq(processedMessages.provider, provider),
          eq(processedMessages.externalMessageId, externalMessageId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Marca a mensagem como processada (chamar SÓ após sucesso). Idempotente:
 * reentrega concorrente do mesmo id não duplica (ON CONFLICT DO NOTHING).
 */
export async function markMessageProcessed(
  provider: string,
  externalMessageId: string,
  conversationKey: string,
): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(processedMessages)
      .values({ tenantId, provider, externalMessageId, conversationKey })
      .onConflictDoNothing({
        target: [
          processedMessages.tenantId,
          processedMessages.provider,
          processedMessages.externalMessageId,
        ],
      });
  });
}
