-- M7 (revisão Codex #1): FK composta por tenant nas referências a conversations.
-- Sem isto, um job/payload com (tenantA, conversationB) criaria referência
-- cross-tenant válida (RLS protege a linha nova, mas a FK escalar não amarra o
-- tenant). UNIQUE(tenant_id, id) + FK (tenant_id, conversation_id).
ALTER TABLE conversations
  ADD CONSTRAINT conversations_tenant_id_uniq UNIQUE (tenant_id, id);

ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_conversation_id_fkey;
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_conversation_same_tenant_fk
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id) ON DELETE SET NULL;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_conversation_id_fkey;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_conversation_same_tenant_fk
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id) ON DELETE SET NULL;

ALTER TABLE crm_external_sync DROP CONSTRAINT IF EXISTS crm_external_sync_conversation_id_fkey;
ALTER TABLE crm_external_sync
  ADD CONSTRAINT crm_external_sync_conversation_same_tenant_fk
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id) ON DELETE CASCADE;
