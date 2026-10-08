# ADR 0040 — Persistência cifrada de sessão Baileys

## Contexto
O auth state do Baileys (creds + signal keys) é o que permite reabrir a sessão sem
re-escanear o QR. É **material sensível** (equivale a estar logado no WhatsApp do
cliente) e **muda com frequência** (a cada `creds.update`). Precisa sobreviver a
restart do session-worker, por número, isolado por tenant.

## Decisão
- **Tabela dedicada `baileys_sessions`** (uma linha por `tenant_id` + número), não o
  `tenant_secrets` (que é uma chave por kind — não comporta múltiplos números). RLS
  **FORCE + policy `NULLIF`** padrão; entra no `TENANT_SCOPED_TABLES` (coberta pelo
  catálogo RLS).
- **Mesma envelope encryption** dos segredos (`BaileysSessionStore` espelha o
  `TenantSecretsStore`): o blob é cifrado fora do banco, AAD
  `tenantId:baileys_session:phone` amarrando o ciphertext ao tenant **e** ao número
  — transplantar a linha entre tenants/números é detectado (teste prova que o blob
  de A não descriptografa no contexto de B). **Nunca em log.**
- **Persistência dirigida por evento:** o manager salva no `creds.update`; restaura
  no `connect` (decifra → `authState`). `logout`/sessão inválida → `clear` (apaga) +
  conexão sai do roteamento + exige novo pareamento.

## Consequências
Reconexão sem novo QR após restart (testado). O custo é uma escrita cifrada por
`creds.update` (frequente no início da sessão, rara depois) — aceitável. A rotação
de KEK do projeto cobre estes blobs como qualquer segredo. Se o cliente revoga o
aparelho no app, o `logged_out` limpa o blob e o painel exige novo QR.
