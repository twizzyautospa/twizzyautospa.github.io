-- Installers: the B2B customers. Each one gets a white-labelled quote link.
CREATE TABLE installers (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  company_name  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  inbound_key   TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leads: one per homeowner request. Quote and booking live on the lead.
CREATE TABLE leads (
  id             TEXT PRIMARY KEY,
  installer_id   TEXT NOT NULL REFERENCES installers(id) ON DELETE CASCADE,
  public_token   TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'new',
  source         TEXT NOT NULL DEFAULT 'quiz',
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  selections     JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimate       JSONB,
  photos         JSONB NOT NULL DEFAULT '[]'::jsonb,
  previews       JSONB NOT NULL DEFAULT '{}'::jsonb,
  measurement    JSONB,
  quote          JSONB,
  booking        JSONB,
  notes          TEXT NOT NULL DEFAULT '',
  ip_hash        TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX leads_installer_created_idx ON leads (installer_id, created_at DESC);
CREATE INDEX leads_created_idx ON leads (created_at DESC);
CREATE INDEX leads_ip_created_idx ON leads (ip_hash, created_at DESC);

-- Platform-wide settings (platform name, session secret).
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Failed-login tracking for lockouts.
CREATE TABLE login_attempts (
  identifier   TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ
);
