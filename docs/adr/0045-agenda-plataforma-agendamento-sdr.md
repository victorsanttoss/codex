# ADR 0045 — Agenda da plataforma + agendamento REAL pela SDR (M15)

## Contexto
Até o M14 a SDR só registrava a **intenção** de agendar (`register_scheduling_intent`,
M7) e escalava o lead qualificado para um humano marcar o horário. O produto quer
fechar o ciclo: a SDR **marca o horário de verdade**, contra a agenda real do
profissional — que pode morar na plataforma ou no Google Calendar.

## Decisão
- **Agenda da plataforma** (migration 0034): `calendars` (N por tenant, v1 usa a
  default única; fuso IANA por agenda) + `calendar_events` (RLS FORCE padrão;
  FK composta `(tenant_id, calendar_id)` e `(tenant_id, appointment_id)` no padrão
  0007/0010 — a segunda com `ON DELETE SET NULL (appointment_id)`, PG15+). A UI
  (`/agenda`, estilo Google Agenda: mês/semana/dia) faz CRUD via
  `/admin/calendar/*` (papel `agent`; vínculo externo exige `admin`).
- **Google Calendar via CONTA DE SERVIÇO da plataforma** (uma credencial para
  todos os tenants, `GOOGLE_CALENDAR_SA_JSON`): o cliente compartilha a agenda
  com o e-mail da SA e cola o ID no onboarding (etapa 5, validação de acesso na
  hora). Sem SDK do Google — JWT RS256 via `node:crypto` + fetch (3 chamadas:
  freeBusy, insert, delete). Isolamento do vínculo: índice único GLOBAL em
  `external_calendar_id` (0035) — uma agenda Google pertence a UM tenant.
- **Disponibilidade é CÓDIGO, não LLM** (`availability.ts`, funções puras no
  espírito do motor de qualificação M6): slots livres = janela de atendimento do
  tenant (config `scheduling`, clampada) − eventos internos − freeBusy do Google.
  Toda matemática de calendário no **fuso do tenant** via Intl (produto
  multi-tenant; nada de offset fixo). Falha do Google na CONSULTA é fail-closed
  (não sugerimos horário que pode colidir); falha só no ESPELHO do evento não
  desfaz a reserva interna (painel = fonte da verdade + aviso na notificação).
- **Tools novas** (`get_available_slots`, `book_appointment`) **substituem** o
  `register_scheduling_intent` quando o agendamento está habilitado — a IA nunca
  inventa horário: repassa o `starts_at` exato emitido pelas sugestões (o serviço
  ainda revalida grade/antecedência/janela/colisão na reserva).
- **Fluxo pós-qualificação muda por opt-in**: qualificado com agendamento ligado
  NÃO silencia — kickoff **determinístico** (template em código, família da
  handoffMessage) oferece 1 horário de manhã + 1 de tarde reais e o lead segue
  `qualified/scheduling` → `scheduled` na reserva. Agenda lotada/indisponível →
  handoff clássico. Remarcação cancela a reserva anterior (appointment + evento +
  espelho Google).
- **Double-booking fechado NO BANCO** (0035): exclusion constraint (btree_gist,
  extensão criada no INIT do container como o pgvector) sobre
  `tstzrange(starts_at, ends_at)` só para `source='sdr'` não-cancelado — dois
  turnos concorrentes no mesmo slot: um ganha, o outro recebe 23P01, desfaz o
  appointment e reoferece alternativas. Eventos manuais podem se sobrepor de
  propósito (como no Google Agenda).
- **Playground reflete produção** com `dryRun` na reserva (valida tudo, não
  persiste). Reserva real notifica o time (`LeadOutcomeService`, idempotente por
  appointment) e sincroniza o CRM (status `scheduled`).

## Consequências
O ciclo lead → qualificação → **horário marcado** fecha sem humano no meio (o
humano segue podendo assumir a qualquer momento — takeover intocado). O
onboarding ganhou a etapa 5 "Agenda & horários" (9 etapas; `activateOnboarding`
usa `FINAL_STEP`). Trade-offs aceitos: freeBusy do Google é consultado por turno
na fase de agendamento (custo de latência só nessa fase; cache fica para
follow-up); `hasEventOverlap` pré-checa mas a garantia é a constraint;
remarcação para horário que SOBREPÕE a reserva atual do próprio lead é recusada
com motivo explícito (a exclusion 0035 impede criar o novo evento antes de
cancelar o antigo, e cancelar antes arrisca perder os dois; as sugestões nunca
oferecem slot que colide com o atual, então o caminho só ocorre com horário
fora das opções);
sincronização é unidirecional (plataforma → Google; webhook de volta é
follow-up). Rotação da chave da SA é operação de plataforma (env), não de tenant.
