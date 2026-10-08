-- M14: conversa de SANDBOX do Playground. O agente REAL roda contra ela, mas ela
-- é EXCLUÍDA das listas/funil do painel (não polui leads/conversas reais) e o
-- envio ao WhatsApp/CRM/cadência não acontece (o Playground captura a resposta).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sandbox boolean NOT NULL DEFAULT false;
