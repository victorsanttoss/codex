# @sdr/crm-kommo

Adaptador de CRM para o **Kommo** (ex-amoCRM), API v4 — para o cliente que já usa
o Kommo e não quer migrar de ferramenta. A SDR IA qualifica/agenda no WhatsApp e
sincroniza o lead pronto para o funil do Kommo. Reaproveita toda a infra de sync
(fila `crm-sync`, retry, dedup, secrets por tenant); aqui mora só o conector.

## O que a integração faz

A cada desfecho do agente (lead **qualificado / handoff / agendado**):
1. **Contato** — dedup por telefone (`GET /contacts?query=`); cria se não existir
   (telefone no custom-field padrão `PHONE`).
2. **Qualificação** — vira uma **nota** no contato (renda, FGTS, etc.) — sem
   precisar mapear IDs de custom-field por conta.
3. **Lead (oportunidade)** — 1 lead por conversa: reusa o lead já criado por nós
   (id guardado em `crm_external_sync`) e atualiza a etapa; cria na 1ª vez.

## Como ativar para um tenant

1. **No Kommo do cliente:** criar uma *integração privada* e gerar um **token de
   longa duração** (Configurações → Integrações → criar integração → "chave de
   longa duração"). Anotar o **subdomínio** da conta (ex.: `acme.kommo.com`).
2. **Guardar o token** no cofre do tenant (cifrado): secret `crm_api_key`.
3. **Config do agente** (`agent_config.crm`):
   ```json
   {
     "crmAdapter": "kommo",
     "kommoBaseURL": "https://acme.kommo.com",
     "kommoPipelineId": 123,   // opcional — funil de destino
     "kommoStatusId": 456      // opcional — etapa inicial
   }
   ```
   Sem `kommoBaseURL` válido (https, domínio público) **ou** sem o token, cai em
   `builtin` (fail-safe, não quebra o sync). Sem `pipelineId/statusId`, o lead cai
   no funil principal / 1ª etapa ("Leads de entrada").

## Auth

Token de **longa duração** (Bearer) — simples para 1 conta por cliente. OAuth 2.0
completo (multi-conta/marketplace) fica para um cenário futuro.

## Limitações conhecidas (validar com conta real)

- **Dedup de contato** por `?query=<telefone>`: um contato criado fora da
  plataforma em outro formato (`(11) 9...`) pode não casar e duplicar. Entre
  chamadas nossas há auto-consistência (sempre `+E.164`).
- **Nota de sync** (`addActivity`) só na 1ª sincronização; se falhar, não é
  re-tentada (a qualificação já virou nota no contato).
- Sem conta Kommo real ainda: shapes conferidos contra a API v4 pública e cobertos
  por testes unitários (mock HTTP) + revisão adversarial. Um smoke end-to-end com
  conta real (ou trial) confirma funil/etapa/custom-fields antes do go-live.
