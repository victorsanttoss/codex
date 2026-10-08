# ADR 0006 — Autenticação do painel (JWT access + refresh)

## Contexto
O painel precisa de login com senha, seleção de tenant ativo (um usuário pode
pertencer a vários tenants) e RBAC (`owner` > `admin` > `agent`).

## Decisão
- Senha com **argon2id**.
- **JWT access curto** (~15min) com claims `{ sub, tenantId, role }` + **refresh**
  (claims `{ sub, tenantId }`), com segredos **distintos** por tipo.
- Tokens entregues também em **cookies httpOnly** (`access_token`, `refresh_token`);
  o body retorna o access token para clientes baseados em header.
- Seleção de tenant ativo a partir das memberships; `switch-tenant` reemite o
  access com o novo tenant/role; `refresh` rotaciona validando a membership.
- RBAC hierárquico por guard global (`RolesGuard`), após o `JwtAuthGuard`.

## Simplificação consciente do M1 (FECHADA na migration 0031)
O refresh era um **JWT stateless** (sem tabela de revogação). Agora cada refresh
emitido tem uma **sessão server-side** (`auth_sessions`): o JWT carrega um `jti`
de alta entropia e a tabela guarda só o **sha256(jti)**. Semântica:
- **Login/switch**: cria a sessão; login faz um sweep oportunista (DELETE) das
  sessões já expiradas do usuário; switch revoga a sessão do refresh apresentado.
- **Refresh**: valida assinatura + sessão existente não-revogada/não-expirada e
  **rotaciona** (revoga a antiga, emite nova). **Reuso** de um token já
  rotacionado revoga TODAS as sessões do usuário (detecção de roubo, OWASP).
- **Logout**: revoga a sessão do refresh apresentado (além de limpar cookies).
- Troca de senha (quando existir endpoint): `AuthService.revokeAllSessions`.
- Access token segue **stateless** (expiração curta ~15min inalterada).
RLS de `auth_sessions` segue o padrão de `memberships` (tenant OU o próprio
usuário via `app.user_id` — refresh/logout rodam antes de haver tenant ativo).

Login equaliza timing (verify dummy quando o e-mail não existe) para não vazar
existência de conta. Tenant `suspended/deleted` é bloqueado em login/refresh/switch.

## Limitações conhecidas
- **CSRF:** endpoints com cookie auth não têm token CSRF. `SameSite=Lax` mitiga o
  caso clássico, e o `apps/web` usa Bearer (não cookie) por padrão. Antes de
  expor mutações sensíveis via cookie, adicionar checagem de `Origin/Referer` ou
  token CSRF.
- ~~**Revogação:** refresh stateless; um refresh vazado vale até expirar.~~
  Resolvido (0031): sessões de refresh com rotação + detecção de reuso.

## Consequências
Login/refresh/switch/RBAC funcionam e são testados (unit + e2e). Logout limpa os
cookies com as opções corretas (path `/auth` para o refresh).
