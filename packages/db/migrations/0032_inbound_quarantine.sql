-- Quarentena de inbound para conexão NÃO-ativa. Antes, mensagem de lead cuja
-- conexão estava `disconnected`/`connecting` (ex.: token 401, desconexão
-- temporária) era DESCARTADA em silêncio pelo pipeline (o resolve só devolve
-- conexões `active`). Agora o payload do webhook (o MESMO job que a
-- WebhookQueue recebe: {headers, query, rawBody} — replay fiel, inclusive a
-- verificação de assinatura) fica em quarentena; um sweep periódico re-enfileira
-- quando a conexão volta a `active` (em ordem de received_at) e marca
-- replayed_at. O dedup do pipeline (processed_messages) protege contra replay
-- duplicado. Linhas velhas expiram (~48h) — fora da janela de 24h a resposta
-- free-form já não seria possível mesmo.
CREATE TABLE inbound_quarantine (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL, -- ref da conexão (channel_connections.phone_number_id)
  payload         jsonb NOT NULL, -- WebhookJob {headers, query, rawBody}
  received_at     timestamptz NOT NULL DEFAULT now(),
  replayed_at     timestamptz,
  expires_at      timestamptz NOT NULL
);
-- Sweep busca pendentes por tenant em ordem de chegada; parcial (replayed_at
-- IS NULL) mantém o índice pequeno mesmo com histórico de replays retido.
CREATE INDEX inbound_quarantine_pending_idx
  ON inbound_quarantine (tenant_id, received_at)
  WHERE replayed_at IS NULL;

-- RLS padrão (tenant-scoped puro, como 0002/0020).
ALTER TABLE inbound_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_quarantine
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
