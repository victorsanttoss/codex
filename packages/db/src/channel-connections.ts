import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { requireTenantContext, runWithTenant, type TenantSecretKind } from "@sdr/core";
import { getDb, withTenant } from "./client";
import { channelConnections, tenants } from "./schema";

// `connecting` = registrada mas ainda NÃO pareada (Baileys: aguardando o scan do
// QR). Só vira `active` quando o socket abre de verdade. Assim o tenant não
// aparece como "conectado" antes do pareamento (banner do início, envio proativo).
export type ConnectionStatus = "active" | "connecting" | "disconnected" | "revoked";

export interface ResolvedConnection {
  tenantId: string;
  connectionId: string;
  secretRef: TenantSecretKind;
}

/**
 * Resolve a conexão (e o tenant) a partir do phone_number_id — caminho SYSTEM,
 * usado pelo webhook ANTES de haver tenant ativo. Não expõe a tabela inteira:
 * seta `app.resolve_phone` para que a policy libere SÓ a linha daquele número.
 */
export async function resolveConnectionByPhoneNumberId(
  phoneNumberId: string,
): Promise<ResolvedConnection | null> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.resolve_phone', ${phoneNumberId}, true)`);
    const rows = await tx
      .select({
        tenantId: channelConnections.tenantId,
        connectionId: channelConnections.id,
        secretRef: channelConnections.secretRef,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.phoneNumberId, phoneNumberId),
          eq(channelConnections.status, "active"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * O número já pertence a OUTRO tenant? Usado no onboarding (Baileys) para
 * responder 409 amigável — sem isto, o upsert batia na unique de
 * phone_number_id, o RLS bloqueava o UPDATE cross-tenant e virava 500 cru.
 * Caminho SYSTEM (policy `system_scan`) devolvendo SÓ um boolean — nenhum dado
 * do outro tenant vaza.
 */
export async function isPhoneNumberTakenByOtherTenant(phoneNumberId: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scan', 'on', true)`);
    const rows = await tx
      .select({ tenantId: channelConnections.tenantId })
      .from(channelConnections)
      .where(eq(channelConnections.phoneNumberId, phoneNumberId))
      .limit(1);
    return rows.length > 0 && rows[0]!.tenantId !== tenantId;
  });
}

export interface UpsertConnectionInput {
  phoneNumberId: string;
  wabaId?: string;
  displayPhone?: string;
  secretRef?: TenantSecretKind;
  tokenExpiresAt?: Date;
  systemUserId?: string;
  subscribedAt?: Date;
  /** Provedor do canal: 'cloud_api' (default) ou 'baileys' (M13). */
  provider?: string;
  /**
   * Status inicial. Default `active` (cloud_api já nasce usável com o token).
   * Baileys passa `connecting` — só vira `active` quando o socket pareia.
   */
  status?: ConnectionStatus;
}

/** Registra/atualiza a conexão do tenant ativo (reativa em reconexão). */
export async function upsertChannelConnection(input: UpsertConnectionInput): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(channelConnections)
      .values({
        tenantId,
        phoneNumberId: input.phoneNumberId,
        provider: input.provider ?? "cloud_api",
        wabaId: input.wabaId ?? null,
        displayPhone: input.displayPhone ?? null,
        secretRef: input.secretRef ?? "whatsapp_token",
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        systemUserId: input.systemUserId ?? null,
        subscribedAt: input.subscribedAt ?? null,
        status: input.status ?? "active",
        lastLifecycleEventAt: new Date(),
      })
      .onConflictDoUpdate({
        target: channelConnections.phoneNumberId,
        set: {
          ...(input.provider ? { provider: input.provider } : {}),
          wabaId: input.wabaId ?? null,
          displayPhone: input.displayPhone ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          systemUserId: input.systemUserId ?? null,
          subscribedAt: input.subscribedAt ?? null,
          status: input.status ?? "active",
          lastLifecycleEventAt: new Date(),
        },
      });
  });
}

export interface TenantConnection {
  connectionId: string;
  phoneNumberId: string;
  secretRef: TenantSecretKind;
  /** Provedor do canal: 'cloud_api' (oficial) ou 'baileys' (não-oficial, M13). */
  provider: string;
  /** WABA da conexão (Cloud API) — usado p/ gestão via Graph (ex.: submeter HSM). */
  wabaId: string | null;
}

/**
 * Conexão ATIVA do tenant ativo — FALLBACK de envio quando a linha do outbox não
 * tem `connection_id` (migration 0030). O roteamento primário é por conexão da
 * CONVERSA (getConnectionForConversation).
 */
export async function getActiveConnectionForTenant(): Promise<TenantConnection | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        connectionId: channelConnections.id,
        phoneNumberId: channelConnections.phoneNumberId,
        secretRef: channelConnections.secretRef,
        provider: channelConnections.provider,
        wabaId: channelConnections.wabaId,
      })
      .from(channelConnections)
      .where(and(eq(channelConnections.tenantId, tenantId), eq(channelConnections.status, "active")))
      // Determinismo com múltiplas conexões ativas: sem ORDER BY o Postgres pode
      // devolver qualquer linha (envio alternaria de número entre ticks). A mais
      // ANTIGA vence. Linhas de outbox com connection_id (0030) não passam por
      // aqui — este fallback só vale para linhas sem vínculo.
      .orderBy(channelConnections.createdAt, channelConnections.id)
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Conexão + status, para roteamento explícito de saída (outbox multi-conexão). */
export interface RoutedConnection extends TenantConnection {
  status: string;
}

/**
 * Conexão pela qual a CONVERSA chegou — derivada da `conversation_key`
 * (`{provider}:{phone_number_id}:{wa_id}`, ADR 0010). Retorna QUALQUER status:
 * a identidade do número não muda porque a conexão caiu (o envio decide o que
 * fazer com conexão inativa). NULL quando a chave não segue a convenção (ex.:
 * sandbox) ou a conexão foi apagada.
 */
export async function getConnectionForConversation(
  conversationId: string,
): Promise<RoutedConnection | null> {
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT cc.id AS "connectionId", cc.phone_number_id AS "phoneNumberId",
             cc.secret_ref AS "secretRef", cc.provider, cc.status,
             cc.waba_id AS "wabaId"
      FROM conversations c
      JOIN channel_connections cc
        ON cc.phone_number_id = split_part(c.conversation_key, ':', 2)
       AND cc.tenant_id = c.tenant_id
      WHERE c.id = ${conversationId}
      LIMIT 1
    `)) as unknown as RoutedConnection[];
    return rows[0] ?? null;
  });
}

/**
 * TODAS as conexões ATIVAS do tenant ativo (opcionalmente por provedor) — usado
 * pelo claim particionado do outbox (session-worker filtra os números cujo
 * socket é DESTE worker).
 */
export async function listConnectionsForTenant(provider?: string): Promise<TenantConnection[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    return tx
      .select({
        connectionId: channelConnections.id,
        phoneNumberId: channelConnections.phoneNumberId,
        secretRef: channelConnections.secretRef,
        provider: channelConnections.provider,
        wabaId: channelConnections.wabaId,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.tenantId, tenantId),
          eq(channelConnections.status, "active"),
          ...(provider ? [eq(channelConnections.provider, provider)] : []),
        ),
      )
      .orderBy(channelConnections.createdAt, channelConnections.id);
  });
}

export interface ProviderConnection {
  tenantId: string;
  phoneNumberId: string;
  displayPhone: string | null;
}

/**
 * Lista TODAS as conexões de um provedor nos `statuses`, por tenant ativo —
 * usado pelo session-worker (M13) no reconcile (a cada 15s). UMA query
 * cross-tenant read-only via caminho system (policy `system_scan`, mesma
 * migração 0029) — antes era N+1 (1 tx por tenant a cada tick).
 */
export async function listActiveConnectionsByProvider(
  provider: string,
  statuses: ConnectionStatus[] = ["active"],
): Promise<ProviderConnection[]> {
  if (statuses.length === 0) return [];
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scan', 'on', true)`);
    const rows = await tx
      .select({
        tenantId: channelConnections.tenantId,
        phoneNumberId: channelConnections.phoneNumberId,
        displayPhone: channelConnections.displayPhone,
      })
      .from(channelConnections)
      .innerJoin(
        tenants,
        and(eq(tenants.id, channelConnections.tenantId), eq(tenants.status, "active")),
      )
      .where(
        and(
          inArray(channelConnections.status, statuses),
          eq(channelConnections.provider, provider),
        ),
      )
      .orderBy(channelConnections.createdAt, channelConnections.id);
    return rows;
  });
}

/** Conta conexões do tenant ativo que NÃO estão `active` — sinal de alerta (M11). */
export async function countNonActiveConnections(): Promise<number> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT count(*)::int AS n FROM channel_connections
      WHERE tenant_id = ${tenantId} AND status <> 'active'`);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  });
}

export interface ConnectionOwner {
  tenantId: string;
  status: string;
}

/**
 * Dono atual de um phone_number_id (QUALQUER status) — caminho system, usado no
 * GUARD de conflito do signup. Diferente do resolve (que filtra só ativo).
 */
export async function findConnectionOwner(
  phoneNumberId: string,
): Promise<ConnectionOwner | null> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.resolve_phone', ${phoneNumberId}, true)`);
    const rows = await tx
      .select({ tenantId: channelConnections.tenantId, status: channelConnections.status })
      .from(channelConnections)
      .where(eq(channelConnections.phoneNumberId, phoneNumberId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Transição de status (lifecycle) da conexão do tenant ativo. */
export async function setConnectionStatus(
  phoneNumberId: string,
  status: ConnectionStatus,
): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const updated = await tx
      .update(channelConnections)
      .set({ status, lastLifecycleEventAt: new Date() })
      .where(
        and(
          eq(channelConnections.tenantId, tenantId),
          eq(channelConnections.phoneNumberId, phoneNumberId),
        ),
      )
      .returning({ id: channelConnections.id });
    return updated.length > 0;
  });
}

export interface ExpiringConnection {
  phoneNumberId: string;
  tokenExpiresAt: Date | null;
  /** Onde o token de envio está cifrado — p/ o refresh gravar o token novo. */
  secretRef: TenantSecretKind;
}

/** Conexões ATIVAS do tenant ativo com token vencendo antes de `before`. */
export async function listExpiringConnections(before: Date): Promise<ExpiringConnection[]> {
  return withTenant(async (tx) => {
    return tx
      .select({
        phoneNumberId: channelConnections.phoneNumberId,
        tokenExpiresAt: channelConnections.tokenExpiresAt,
        secretRef: channelConnections.secretRef,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.status, "active"),
          lte(channelConnections.tokenExpiresAt, before),
        ),
      );
  });
}

/** Ids de tenants ativos (caminho system; tenants não é RLS) — para o job iterar. */
export async function listActiveTenantIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  return rows.map((r) => r.id);
}

/**
 * Resolve tenant + TODOS os números de uma waba_id (uma WABA pode ter vários
 * números; eventos de conta devem afetar todos). Itera tenants ativos —
 * aceitável pois eventos de conta são raros; poderia virar um branch de policy
 * (app.resolve_waba) se a frequência crescer.
 */
export async function findConnectionsByWaba(
  wabaId: string,
): Promise<{ tenantId: string; phoneNumberIds: string[] } | null> {
  for (const tenantId of await listActiveTenantIds()) {
    const rows = await runWithTenant({ tenantId }, () =>
      withTenant((tx) =>
        tx
          .select({ phoneNumberId: channelConnections.phoneNumberId })
          .from(channelConnections)
          .where(eq(channelConnections.wabaId, wabaId)),
      ),
    );
    if (rows.length > 0) {
      return { tenantId, phoneNumberIds: rows.map((r) => r.phoneNumberId) };
    }
  }
  return null;
}
