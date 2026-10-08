# ADR 0025 — Ports de CRM, agendamento e notificação

## Contexto
O fechamento do ciclo do lead (registrar no CRM, agendar, notificar o time) não
pode acoplar o núcleo a um CRM/calendário/canal específico. O produto também
precisa funcionar **sem nenhum CRM externo**.

## Decisão
- **Três ports agnósticos** no core: `CrmProvider`
  (`upsertContact`/`upsertOpportunity`/`addActivity?`), `SchedulingProvider`
  (`createAppointment`) e `NotificationProvider` (`notify`). Cada um com contract
  suite e fake; registrados no `ProviderRegistry`. Erros viram `CrmError`
  (categoria segura, sem vazar payload/chave).
- **Built-in é o default**: adaptadores que gravam em tabelas internas
  tenant-scoped (`crm_contacts`/`opportunities`/`activities`/`appointments`/
  `notifications`). O produto opera ponta a ponta sem CRM externo.
- **Adaptador externo** (`@sdr/crm-http`): genérico via HTTP (HubSpot/Pipedrive/
  webhook próprio expõem o mesmo shape). Cliente injetável; chave do tenant via
  `crm_api_key`.
- **Agnosticismo garantido por teste**: o teste estrutural do core passou a banir
  também SDKs de CRM (`hubspot`/`pipedrive`/`@sdr/crm-`).
- Resolução **por tenant** (`CrmConfigService`, data-driven, validado/clampado):
  qual adapter, baseURL, fuso, duração. A camada de nicho pode sobrescrever depois
  (mesmo padrão do agente).

## Consequências
Trocar/adicionar CRM não toca o núcleo nem o agente. Calendário externo (Google) e
notificação externa (Slack/e-mail) entram como novos adaptadores sem refator. O
desfecho do agente (M6) é consumido por uma facade (`LeadOutcomeService`), mantendo
o handler desacoplado dos provedores concretos.
