# ADR 0044 — Identidade por-staff na Área da Plataforma (token pessoal + papel + auditoria)

Status: aceito · 2026-07-06 · resolve dívida do M14 (staff) e do motor (identidade forte do curador)

## Contexto

A Área da Plataforma (M14) autenticava com um **token único compartilhado**
(`PLATFORM_ADMIN_TOKEN`, header `x-platform-token`, `PlatformGuard`). Consequências:

- **Sem identidade:** quem detém o token faz tudo; nada é atribuído a uma pessoa.
- **Papéis decorativos:** `platform_staff` (admin/curator/support) era um diretório
  de exibição; a matriz de permissões da tela era hardcoded e **não enforçada**.
- **Atribuição falsa:** a curadoria (aprovar/rejeitar candidato) recebia um
  `curatorId` de **texto livre** — o web mandava `curatorId: "staff"` fixo.

Isso também era a dívida do motor: "identidade forte do curador + auditoria imutável".

## Decisão

**Um token PESSOAL por membro de staff**, atrás do mesmo header, resolvido para uma
identidade concreta. Sem tela de login/senha (mantém o modelo de header do M14).

1. **`platform_staff.token_hash`** (migration 0025): sha256 do token pessoal (nunca
   o token cru), índice único parcial. O token é de alta entropia → o lookup por
   igualdade de hash não abre canal de tempo útil.
2. **`PlatformStaffGuard`** resolve `x-platform-token`:
   1. casa com `token_hash` de um staff → **aquela identidade** (papel da linha);
   2. senão, casa (tempo constante) com o `PLATFORM_ADMIN_TOKEN` → identidade de
      **bootstrap** `platform-admin` (papel admin) — compat + superadmin/seed;
   3. senão → nega (fail-closed).
   A identidade fica em `req.staff` (`@Staff()`).
3. **Enforcement de papel** por endpoint via `@RequireStaffRole(...)`; `admin` passa
   em tudo. Curadoria e `kit.apply` exigem `curator`/`admin`; `support` só lê.
4. **Auditoria:** `approve`/`reject`/`promote`/`kit.apply` gravam em `audit_log`
   (append-only, `actor = staff.id`) — trilha imutável de quem fez o quê. A curadoria
   passa o `staff.id` REAL como `curatorId` (fim do texto livre).
5. **Web:** o gate valida o token contra `GET /platform/me` (não guarda às cegas) e
   mostra a identidade real; a matriz de permissões vira documentação da política
   enforçada no servidor.

## Consequências

- **Positivas:** atribuição real e auditável; papéis passam a valer; superfície
  mínima (um header, sem sessão/senha); compat total (o token compartilhado ainda
  funciona como admin de bootstrap); fecha a dívida do curador do motor.
- **Custo/limites:** o token pessoal é um segredo portador (bearer) — se vazar,
  personifica aquele staff (rotação = `setStaffTokenHash`); não há expiração/refresh
  (aceitável para staff interno; evolução seria login+sessão se o time crescer);
  a matriz de permissões da UI é informativa (a fonte da verdade é o guard).
- **Auditoria best-effort pós-commit:** a mutação sensível commita na transação do
  service; o `audit_log` é gravado logo depois (best-effort — falha loga `warn`, não
  mascara a ação). Trilha append-only, não atômica com a mutação (RLS corrigida em
  0026 torna a falha rara). Ver `docs/M14-staff-identity-codex-review.md`.
- **Dívida remanescente:** ~~gestão de staff pela UI~~ RESOLVIDA em 2026-07-06
  (`PlatformStaffController`: criar/rotacionar/remover, admin-only, token cru 1x,
  auditado); `support`/`impersonar` ainda não têm endpoints próprios.

## Alternativas descartadas

- **Login completo (email+senha+JWT) de staff:** robusto, porém muito mais superfície
  (argon2, refresh, tela) para um time interno pequeno — adiado.
- **Só atribuição sobre o token compartilhado:** exigir que `curatorId` casasse com um
  staff real sem auth por-pessoa — a identidade continuaria spoofável por quem tem o
  token; não é identidade de verdade.
