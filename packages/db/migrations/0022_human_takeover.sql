-- M14: "Assumir conversa" — um humano assume e a IA PAUSA naquela conversa. Flag
-- na conversation; o handler do agente já checa gates (opt-out/cadência) no topo,
-- e passa a checar este também (guardrail, não muda a lógica do agente). Herda a
-- RLS por tenant de conversations.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS human_takeover boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_takeover_at timestamptz;
