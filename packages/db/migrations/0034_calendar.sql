-- M15: agenda da plataforma (estilo Google Agenda) + vínculo com agenda externa
-- (Google Calendar via conta de serviço). `calendars` já nasce N-por-tenant
-- (multi-profissional é futuro; v1 usa uma default por tenant). Eventos
-- tenant-scoped com RLS padrão; FK composta (tenant_id, calendar_id) impede
-- referência cross-tenant (padrão 0007/0010).

CREATE TABLE calendars (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 text NOT NULL DEFAULT 'Agenda principal',
  timezone             text NOT NULL DEFAULT 'America/Sao_Paulo',
  provider             text NOT NULL DEFAULT 'internal', -- 'internal' | 'google'
  -- ID da agenda no provedor externo (ex.: xxx@group.calendar.google.com).
  -- NÃO é segredo (o acesso real é da conta de serviço da plataforma).
  external_calendar_id text,
  is_default           boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendars_tenant_id_uniq UNIQUE (tenant_id, id)
);
-- exatamente UMA agenda default por tenant (as demais entram com is_default=false)
CREATE UNIQUE INDEX calendars_tenant_default_uniq ON calendars (tenant_id) WHERE is_default;

-- FK composta appointment→(tenant, id) precisa deste unique (padrão 0007/0010).
ALTER TABLE appointments ADD CONSTRAINT appointments_tenant_id_uniq UNIQUE (tenant_id, id);

CREATE TABLE calendar_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  calendar_id       uuid NOT NULL,
  title             text NOT NULL,
  description       text,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  all_day           boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'cancelled'
  source            text NOT NULL DEFAULT 'manual',    -- 'manual' | 'sdr'
  -- vínculo com o agendamento do CRM quando o evento nasceu da SDR
  appointment_id    uuid,
  -- id do evento espelhado no provedor externo (auditoria/atualização futura)
  external_event_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_ends_after_start CHECK (ends_at > starts_at),
  CONSTRAINT calendar_events_calendar_same_tenant_fk
    FOREIGN KEY (tenant_id, calendar_id) REFERENCES calendars (tenant_id, id) ON DELETE CASCADE,
  -- PG15+: SET NULL só na coluna do vínculo (tenant_id é NOT NULL e fica).
  CONSTRAINT calendar_events_appointment_same_tenant_fk
    FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, id) ON DELETE SET NULL (appointment_id)
);
-- listagem por range da UI e cálculo de disponibilidade
CREATE INDEX calendar_events_range_idx ON calendar_events (tenant_id, calendar_id, starts_at);

-- ── RLS padrão (tenant-scoped puro, como 0002/0020/0032) ─────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendars', 'calendar_events']
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
