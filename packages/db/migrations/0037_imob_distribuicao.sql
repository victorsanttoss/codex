-- VERTICAL IMOBILIÁRIA (fork sdr-ia-imob): distribuição de leads qualificados
-- para corretores parceiros + acompanhamento do atendimento (SLA).
-- Piloto: Menin / Parque das Flores. Padrões seguidos: RLS tenant-scoped com
-- FORCE (0002/0020/0034), FK composta (tenant_id, id) anti cross-tenant
-- (0007/0010), policy system_scan p/ varredura do scheduler (0029).

-- ── Imobiliárias parceiras (agências) ────────────────────────────────────────
CREATE TABLE imob_agencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- NULL = ativa; setado = fora da distribuição sem apagar histórico
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imob_agencies_tenant_id_uniq UNIQUE (tenant_id, id),
  CONSTRAINT imob_agencies_tenant_name_uniq UNIQUE (tenant_id, name)
);

-- ── Corretores ───────────────────────────────────────────────────────────────
CREATE TABLE imob_brokers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agency_id      uuid,
  name           text NOT NULL,
  -- WhatsApp em dígitos (E.164 sem '+', ex.: 5544999001234). Identifica o
  -- corretor no INBOUND: mensagem dele NUNCA vai para o agente SDR.
  whatsapp       text NOT NULL,
  -- Baileys pode entregar LID no lugar do número (conexão não-oficial);
  -- quando conhecido, também identifica o corretor no inbound.
  wa_id          text,
  -- regiões que atende (vazio = todas); casadas com o campo 'regiao' do lead
  regions        text[] NOT NULL DEFAULT '{}',
  daily_capacity integer NOT NULL DEFAULT 10 CHECK (daily_capacity > 0),
  active         boolean NOT NULL DEFAULT true,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imob_brokers_tenant_id_uniq UNIQUE (tenant_id, id),
  CONSTRAINT imob_brokers_tenant_whatsapp_uniq UNIQUE (tenant_id, whatsapp),
  CONSTRAINT imob_brokers_agency_same_tenant_fk
    FOREIGN KEY (tenant_id, agency_id) REFERENCES imob_agencies (tenant_id, id)
    ON DELETE SET NULL (agency_id)
);

-- ── Atribuição lead → corretor (unidade do atendimento) ──────────────────────
CREATE TABLE imob_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL,
  broker_id        uuid NOT NULL,
  -- offered → accepted | declined | expired (timeout de aceite) | closed
  status           text NOT NULL DEFAULT 'offered',
  -- funil pós-aceite (atualizado pelo corretor via WhatsApp):
  -- em_atendimento | visita_agendada | em_negociacao | sem_contato |
  -- proposta | contrato | sem_interesse
  stage            text,
  -- nº da rodada de distribuição deste lead (1 = primeira oferta)
  attempt          integer NOT NULL DEFAULT 1,
  offered_at       timestamptz NOT NULL DEFAULT now(),
  -- prazo do aceite; vencido → scheduler expira e redistribui
  expires_at       timestamptz NOT NULL,
  responded_at     timestamptz,
  stage_updated_at timestamptz,
  -- o que o PRÓXIMO número enviado pelo corretor responde: 'accept' | 'status'
  awaiting_reply   text,
  prompted_at      timestamptz,
  -- follow-ups de status sem resposta (3 → alerta ao gestor)
  followup_count   integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imob_assignments_tenant_id_uniq UNIQUE (tenant_id, id),
  CONSTRAINT imob_assignments_conversation_same_tenant_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT imob_assignments_broker_same_tenant_fk
    FOREIGN KEY (tenant_id, broker_id) REFERENCES imob_brokers (tenant_id, id)
    ON DELETE CASCADE
);
-- no máximo UMA atribuição ativa por lead (a redistribuição fecha a anterior)
CREATE UNIQUE INDEX imob_assignments_one_active_per_conv
  ON imob_assignments (tenant_id, conversation_id)
  WHERE status IN ('offered', 'accepted');
-- capacidade diária + round-robin (última oferta do corretor)
CREATE INDEX imob_assignments_broker_idx
  ON imob_assignments (tenant_id, broker_id, offered_at DESC);
-- varredura de SLA do scheduler (aceites vencidos / follow-ups devidos)
CREATE INDEX imob_assignments_sla_idx ON imob_assignments (status, expires_at);

-- ── Timeline de eventos (auditoria + métricas de SLA) ────────────────────────
CREATE TABLE imob_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  assignment_id   uuid,
  broker_id       uuid,
  -- qualified | offered | accepted | declined | expired | stage_changed |
  -- followup_sent | note | alert | exhausted
  type            text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imob_events_tenant_id_uniq UNIQUE (tenant_id, id),
  CONSTRAINT imob_events_conversation_same_tenant_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT imob_events_assignment_same_tenant_fk
    FOREIGN KEY (tenant_id, assignment_id) REFERENCES imob_assignments (tenant_id, id)
    ON DELETE SET NULL (assignment_id),
  CONSTRAINT imob_events_broker_same_tenant_fk
    FOREIGN KEY (tenant_id, broker_id) REFERENCES imob_brokers (tenant_id, id)
    ON DELETE SET NULL (broker_id)
);
CREATE INDEX imob_events_conv_idx ON imob_events (tenant_id, conversation_id, created_at);
CREATE INDEX imob_events_type_idx ON imob_events (tenant_id, type, created_at);

-- ── RLS padrão (tenant-scoped puro, como 0002/0020/0034) ─────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['imob_agencies', 'imob_brokers', 'imob_assignments', 'imob_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END $$;

-- varredura system-level do scheduler de SLA (padrão 0029): SELECT-only,
-- habilitada só com app.system_scan='on' na transação da varredura
CREATE POLICY system_scan ON imob_assignments FOR SELECT
  USING (current_setting('app.system_scan', true) = 'on');
