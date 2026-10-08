-- Multi-conexão no outbox: até aqui o envio era roteado por
-- getActiveConnectionForTenant (1 conexão por tenant — a mais antiga vencia).
-- Tenant com 2 números podia mandar mensagem pelo número errado, e a partição
-- cloud/baileys era decidida por TENANT (starvation quando o tenant tem os dois
-- provedores). A coluna registra, no ENQUEUE, a conexão da CONVERSA (derivada da
-- conversation_key, ADR 0010) — o envio roteia pela linha; sem vínculo, cai no
-- fallback por tenant (comportamento de hoje). ON DELETE SET NULL: apagar a
-- conexão não perde a linha do livro-razão (volta ao fallback).
ALTER TABLE outbox_messages ADD COLUMN connection_id uuid REFERENCES channel_connections(id) ON DELETE SET NULL;
-- Índice para o SET NULL do FK e para o claim particionado por conexão.
CREATE INDEX outbox_messages_connection_idx ON outbox_messages (connection_id);
-- Backfill (achado Codex): linhas pré-0030 ficariam NULL e cairiam no fallback
-- por tenant — em tenant multi-conexão é exatamente o bug que a coluna resolve.
-- Deriva a conexão da conversation_key ({provider}:{phone_number_id}:{wa_id},
-- ADR 0010); histórico incluído (custo único, tabela pequena).
UPDATE outbox_messages o
SET connection_id = cc.id
FROM conversations c
JOIN channel_connections cc
  ON cc.tenant_id = c.tenant_id
 AND cc.phone_number_id = split_part(c.conversation_key, ':', 2)
WHERE o.conversation_id = c.id
  AND o.connection_id IS NULL;
