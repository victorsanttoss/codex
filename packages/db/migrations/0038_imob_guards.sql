-- Guardas da vertical imobiliária (achados da revisão Codex do 0037):
--
-- 1. No máximo UMA oferta aguardando ACEITE por corretor: sem isto, duas
--    distribuições concorrentes podem deixar o mesmo corretor com duas ofertas
--    pendentes e o "1" dele vira ambíguo (aceitaria a mais recente). O motor
--    trata a violação tentando o próximo corretor da fila.
CREATE UNIQUE INDEX imob_assignments_one_pending_accept_per_broker
  ON imob_assignments (tenant_id, broker_id)
  WHERE status = 'offered' AND awaiting_reply = 'accept';

-- 2. wa_id (LID Baileys) único por tenant quando preenchido: o inbound
--    identifica corretor por whatsapp OU wa_id; duplicata faria o limit(1)
--    escolher um corretor arbitrário e desviaria aceite/status para a pessoa
--    errada.
CREATE UNIQUE INDEX imob_brokers_tenant_wa_id_uniq
  ON imob_brokers (tenant_id, wa_id)
  WHERE wa_id IS NOT NULL;
