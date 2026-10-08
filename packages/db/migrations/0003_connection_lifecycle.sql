-- M3: Embedded Signup — colunas de lifecycle em channel_connections.
-- RLS já está ENABLE+FORCE com a policy de 2 pernas (tenant_id OU resolve_phone);
-- adicionar colunas não muda a policy. O catálogo RLS segue cobrindo a tabela.

ALTER TABLE channel_connections
  ADD COLUMN token_expires_at        timestamptz,
  ADD COLUMN system_user_id          text,
  ADD COLUMN subscribed_at           timestamptz,
  ADD COLUMN last_lifecycle_event_at timestamptz;

-- Índice para o job de expiração (scan por tenant de conexões ativas a vencer).
CREATE INDEX channel_connections_token_expiry_idx
  ON channel_connections (status, token_expires_at);
