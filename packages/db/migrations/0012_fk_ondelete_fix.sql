-- M8 (revisão Codex #9): FK composta (tenant_id, conversation_id) com ON DELETE
-- SET NULL tentaria anular TAMBÉM tenant_id (NOT NULL) ao apagar a conversa →
-- o DELETE da conversa falharia. Troca para ON DELETE CASCADE (a linha some com
-- a conversa). Afeta opportunities/appointments (0010) e outbox_messages (0011).

ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_conversation_same_tenant_fk;
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_conversation_same_tenant_fk
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_conversation_same_tenant_fk;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_conversation_same_tenant_fk
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS outbox_messages_conversation_same_tenant_fk;
ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_conversation_same_tenant_fk
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id) ON DELETE CASCADE;
