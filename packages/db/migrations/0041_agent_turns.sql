-- Durable reactive turn ledger: the saved response/decision survives retries
-- even after the lead has moved to a terminal stage. Tokens fence old workers.
CREATE TABLE agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  external_message_id text NOT NULL,
  conversation_key text NOT NULL,
  plan jsonb,
  status text NOT NULL DEFAULT 'planning'
    CONSTRAINT agent_turns_status_check CHECK (status IN ('planning', 'ready', 'complete')),
  reply_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT agent_turns_reply_status_check CHECK (reply_status IN ('pending', 'sending', 'sent', 'suppressed', 'uncertain')),
  completed_effects jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT agent_turns_effects_check CHECK (jsonb_typeof(completed_effects) = 'array'),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_turns_event_uniq UNIQUE (tenant_id, conversation_id, external_message_id),
  CONSTRAINT agent_turns_conversation_same_tenant_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_turns_plan_status_check CHECK (
    (status = 'planning' AND plan IS NULL) OR (status IN ('ready', 'complete') AND plan IS NOT NULL)
  ),
  CONSTRAINT agent_turns_lease_check CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX agent_turns_recoverable_idx ON agent_turns (tenant_id, conversation_id, created_at, id)
  WHERE status = 'ready';

ALTER TABLE agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_turns
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
