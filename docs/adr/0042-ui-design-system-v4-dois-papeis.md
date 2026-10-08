# ADR 0042 — Design system V4 (tokens→componentes) e duas áreas por papel

## Contexto
O motor (M1–M13) estava completo, mas sem camada de produto: a UI era um scaffold
escuro com telas soltas. O M14 entrega a interface **fiel ao design V4 aprovado**,
em **duas áreas por permissão** (Cliente/tenant e Plataforma/staff). O design traz
tokens autoritativos (cores/tipografia/espaçamento/raios/sombras) — não cabe
inventar estética.

## Decisão
- **Tokens como CSS variables** em `app/globals.css` (`:root`) — fonte única dos
  valores do handoff (marca vermelha `#e50914`, neutros, status, raios, sombras).
  **Sem Tailwind/UI lib nova**: CSS Modules por componente + as vars. Mantém zero
  dependência pesada e fidelidade exata. **Fonte Montserrat** via `next/font/google`
  (variável `--font-montserrat`), pesos 400–800.
- **Biblioteca de primitivos** (`components/ui.tsx`): Button (primary/secondary/
  ghost/danger), Card, Badge, **StatusDot com o mapa de status do lead** (novo/
  qualificado/handoff/desqualificado/erro → cores do handoff), Field/Input. Ícones
  de linha inline (`components/icons.tsx`), sem dependência.
- **App shell reutilizável:** UM `Sidebar` (cliente, 228px/`#1a1a1a`) e UM
  `PlatformSidebar` (staff, 236px/`#000`), ambos com prop `active` (não duplicar por
  tela). `Topbar` com o **indicador de estado da SDR sempre visível (3 estados:
  conectada / respondendo agora / conexão caída)** em linguagem do cliente (sem
  termos técnicos).
- **Duas áreas por route group:** `app/(client)/*` (Início/Conversas/Leads/
  Playground/Configuração/Conta) e `app/(platform)/plataforma/*` (Visão global/
  Tenants/Nichos/Curadoria/Templates/Operação/Staff). Cada grupo tem seu shell.
- **Roteamento por papel — duas autenticações distintas:** a área do cliente usa o
  **JWT do tenant** (owner/admin/agent); a área da plataforma usa o **token de
  plataforma** (staff), separado — tenants nunca acessam a plataforma. O guard no
  cliente é **UX**; a **fronteira real de RBAC é a API** (todo endpoint `@Roles` +
  RLS). Login vira split-screen (marca à esquerda, formulário à direita).

## Consequências
A estética fica centralizada nos tokens — telas novas herdam o design sem repetir
valores. Trocar uma cor é mudar uma var. A separação cliente/plataforma reflete as
duas autenticações reais do back-end. **Pendência consciente:** identidade rica de
staff + matriz de permissões por papel é o Épico 6 (hoje o gate de plataforma é por
token); gating server-side do Next (cookie httpOnly + middleware) é refinamento — a
proteção de dados já é garantida pela API. **Telas de conteúdo** (dashboard,
conversas, leads, playground, configuração, plataforma) chegam nos Épicos 2–6;
o Épico 1 entrega tema + shell + roteamento + login.
