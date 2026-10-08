-- 0035: guardas de integridade da agenda (achados Codex da revisão do 0034).
--
-- (1) DOUBLE-BOOKING da SDR: a checagem de colisão do serviço roda ANTES do
-- insert — dois turnos concorrentes confirmando o mesmo slot passavam ambos.
-- Exclusion constraint fecha a corrida NO BANCO, só para eventos da SDR
-- (source='sdr'): eventos manuais/da UI podem se sobrepor de propósito, como
-- no Google Agenda. O serviço traduz a violação (23P01) em "horário ocupado".
-- btree_gist vem do INIT do container (01-roles-and-extensions.sql), como o
-- pgvector — o migrator não tem CREATE no database p/ criar extensão.
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_sdr_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    calendar_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (source = 'sdr' AND status <> 'cancelled');

-- (2) ISOLAMENTO do vínculo Google: todos os tenants usam a MESMA conta de
-- serviço da plataforma, então qualquer tenant conseguiria vincular uma agenda
-- de outro (se soubesse o ID). Uma agenda Google só pode estar vinculada a UM
-- tenant — índice único GLOBAL (fora do RLS, como constraint de catálogo).
-- Primeiro-vence; o controller traduz a violação em erro legível.
CREATE UNIQUE INDEX calendars_external_id_uniq
  ON calendars (external_calendar_id)
  WHERE external_calendar_id IS NOT NULL;
