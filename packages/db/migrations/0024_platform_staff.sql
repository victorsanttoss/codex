-- M14 (refino): identidade de STAFF da plataforma. Dado de PLATAFORMA (não
-- tenant-scoped, como `niches`) — sem RLS de tenant; acesso só atrás do
-- PlatformGuard (token de plataforma). Papéis: admin | curator | support.
CREATE TABLE platform_staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,
  name       text NOT NULL,
  role       text NOT NULL DEFAULT 'support',
  created_at timestamptz NOT NULL DEFAULT now()
);
