-- 0036: POOL de agendas por tenant (multi-recurso) — o "futuro" antecipado no
-- 0034 ("multi-profissional é futuro; v1 usa uma default"). Neutro por vertical:
-- cada linha de `calendars` é uma agenda com `name` livre (Dr. X, Vendedor Y,
-- Corretor Z...). A SDR passa a agendar num POOL: oferece a UNIÃO dos horários
-- livres e grava a reserva na agenda que estiver livre.
--
-- Aditivo e reversível: só adiciona colunas nullable, sem tocar em dados.

-- (1) Remoção "soft" de uma agenda do pool: preserva o histórico de eventos e
-- appointments que já caíram nela. NULL = ativa (participa do pool).
ALTER TABLE calendars ADD COLUMN archived_at timestamptz;

-- (2) Em qual agenda/recurso a reserva caiu. Nullable: appointments antigos (e
-- os que não passam pela agenda) ficam NULL. FK composta (tenant_id, calendar_id)
-- impede referência cross-tenant (mesmo padrão do 0034/0007/0010); SET NULL só
-- na coluna do vínculo quando a agenda é apagada de fato (tenant_id é NOT NULL).
ALTER TABLE appointments ADD COLUMN calendar_id uuid;
ALTER TABLE appointments ADD CONSTRAINT appointments_calendar_same_tenant_fk
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES calendars (tenant_id, id)
  ON DELETE SET NULL (calendar_id);

-- (3) UM evento ativo por appointment. A exclusion do 0034 barra double-book na
-- MESMA agenda+horário; no pool, porém, uma corrida de dois turnos do MESMO
-- appointment poderia gravar em DUAS agendas distintas (não colidem entre si).
-- Este índice fecha isso: o 2º insert do mesmo appointment (em qualquer agenda)
-- viola 23505 e o serviço reusa o evento vencedor (twin). Só cobre reservas da
-- SDR (eventos manuais têm appointment_id NULL).
CREATE UNIQUE INDEX calendar_events_one_active_per_appt
  ON calendar_events (appointment_id)
  WHERE appointment_id IS NOT NULL AND status <> 'cancelled';
