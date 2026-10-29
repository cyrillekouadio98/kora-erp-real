-- =====================================================================
-- Kora ERP — Migration 0001 : socle SaaS multi-entreprises
-- Rôles PostgreSQL attendus (créés par infra/db/init.sql) :
--   kora_owner    propriétaire des tables, exécute les migrations
--   kora_app      rôle de l'API métier (pas de BYPASSRLS)
--   kora_platform rôle des opérations de la plateforme (abonnements, console)
-- Règle : toute table portant company_id a la RLS activée ET forcée.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Contexte de requête posé par l'API dans chaque transaction (SET LOCAL)
CREATE OR REPLACE FUNCTION app_company_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------
-- Identité (globale, sans company_id)
-- ---------------------------------------------------------------------
CREATE TABLE user_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  full_name       text NOT NULL,
  phone           text,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  totp_secret_enc text,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_format CHECK (email = lower(email) AND position('@' in email) > 1)
);
CREATE UNIQUE INDEX user_account_email_uq ON user_account (email);
CREATE TRIGGER user_account_touch BEFORE UPDATE ON user_account FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE platform_role_assignment (
  user_id    uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('super_admin','sales_admin','support','billing')),
  granted_by uuid REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE user_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  token_hash        text NOT NULL UNIQUE,
  active_company_id uuid,
  mfa_verified      boolean NOT NULL DEFAULT false,
  ip                text,
  user_agent        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz
);
CREATE INDEX user_session_user_idx ON user_session (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- Entreprises clientes
-- ---------------------------------------------------------------------
CREATE TABLE company (
  id            uuid PRIMARY KEY,
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  legal_form    text,
  rccm          text,
  tax_id        text,              -- numéro de compte contribuable (NCC)
  tax_regime    text,
  address       text,
  city          text,
  phone         text,
  email         text,
  country_code  char(2) NOT NULL DEFAULT 'CI',
  currency      char(3) NOT NULL DEFAULT 'XOF',
  logo_key      text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  status_reason text,
  created_by    uuid REFERENCES user_account(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER company_touch BEFORE UPDATE ON company FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE company_membership (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  valid_until date,                       -- accès limité (auditeur, consultant)
  is_owner    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, user_id)
);
CREATE INDEX company_membership_user_idx ON company_membership (user_id);
CREATE TRIGGER company_membership_touch BEFORE UPDATE ON company_membership FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE role (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  permissions text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, key)
);
CREATE TRIGGER role_touch BEFORE UPDATE ON role FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE membership_role (
  company_id    uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id       uuid NOT NULL,
  PRIMARY KEY (company_id, membership_id, role_id),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_membership (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, role_id) REFERENCES role (company_id, id) ON DELETE RESTRICT
);

CREATE TABLE invitation (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  email       text NOT NULL CHECK (email = lower(email)),
  role_ids    uuid[] NOT NULL,
  token_hash  text NOT NULL,
  invited_by  uuid NOT NULL REFERENCES user_account(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);

CREATE TABLE numbering_sequence (
  company_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  doc_type   text NOT NULL,
  year       integer NOT NULL,
  prefix     text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (company_id, doc_type, year)
);

CREATE TABLE outbox_event (
  company_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  dedupe_key   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, dedupe_key)
);

-- ---------------------------------------------------------------------
-- Offres et abonnements (plateforme)
-- ---------------------------------------------------------------------
CREATE TABLE plan (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  is_public  boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       uuid NOT NULL REFERENCES plan(id),
  version       integer NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'XOF',
  price_monthly numeric(18,2) NOT NULL CHECK (price_monthly >= 0),
  price_yearly  numeric(18,2) NOT NULL CHECK (price_yearly >= 0),
  trial_days    integer NOT NULL DEFAULT 14 CHECK (trial_days >= 0),
  grace_days    integer NOT NULL DEFAULT 15 CHECK (grace_days >= 0),
  entitlements  jsonb NOT NULL,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

CREATE TABLE subscription (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL UNIQUE REFERENCES company(id) ON DELETE CASCADE,
  plan_version_id      uuid NOT NULL REFERENCES plan_version(id),
  status               text NOT NULL CHECK (status IN ('trialing','active','grace','suspended','cancelled','archived')),
  billing_cycle        text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  grace_until          timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at         timestamptz,
  auto_renew           boolean NOT NULL DEFAULT false,
  overrides            jsonb NOT NULL DEFAULT '{}',   -- dérogations commerciales
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
CREATE TRIGGER subscription_touch BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE subscription_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  type            text NOT NULL,
  from_status     text,
  to_status       text,
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE platform_invoice_seq;
CREATE TABLE platform_invoice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL UNIQUE,
  company_id      uuid NOT NULL REFERENCES company(id),
  subscription_id uuid NOT NULL REFERENCES subscription(id),
  kind            text NOT NULL CHECK (kind IN ('invoice','credit_note')),
  status          text NOT NULL CHECK (status IN ('open','paid','void')),
  currency        char(3) NOT NULL,
  amount          numeric(18,2) NOT NULL,
  lines           jsonb NOT NULL,
  period_start    timestamptz,
  period_end      timestamptz,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  due_at          timestamptz NOT NULL,
  paid_at         timestamptz
);

CREATE TABLE platform_payment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES platform_invoice(id),
  company_id   uuid NOT NULL REFERENCES company(id),
  provider     text NOT NULL,
  provider_ref text NOT NULL,
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  currency     char(3) NOT NULL,
  status       text NOT NULL CHECK (status IN ('succeeded','refunded')),
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

CREATE TABLE payment_webhook_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  event_id     text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome      text,
  UNIQUE (provider, event_id)
);

CREATE TABLE notification (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES company(id) ON DELETE CASCADE,
  type       text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

-- ---------------------------------------------------------------------
-- Accès exceptionnel du support et journal d'audit
-- ---------------------------------------------------------------------
CREATE TABLE support_access_grant (
  company_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES user_account(id),
  reason       text NOT NULL CHECK (length(reason) >= 10),
  scope        text[] NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),
  status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','denied','revoked')),
  decided_by   uuid REFERENCES user_account(id),
  decided_at   timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  company_id  uuid REFERENCES company(id) ON DELETE CASCADE,
  actor_type  text NOT NULL CHECK (actor_type IN ('user','support','platform','system')),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  data        jsonb NOT NULL DEFAULT '{}',
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_company_idx ON audit_log (company_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log est en ajout seul'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION audit_log_append_only();

-- =====================================================================
-- Droits et sécurité au niveau des lignes
-- =====================================================================
GRANT USAGE ON SCHEMA public TO kora_app, kora_platform;
GRANT EXECUTE ON FUNCTION app_company_id(), app_user_id() TO kora_app, kora_platform;

-- Identité : nécessaire avant tout contexte d'entreprise (connexion)
GRANT SELECT, INSERT, UPDATE ON user_account, user_session TO kora_app;
GRANT SELECT ON user_account TO kora_platform;
GRANT SELECT ON platform_role_assignment TO kora_app;
GRANT SELECT, INSERT, DELETE ON platform_role_assignment TO kora_platform;

-- Catalogue d'offres : lisible par l'API, administré par la plateforme
GRANT SELECT ON plan, plan_version TO kora_app;
GRANT SELECT, INSERT, UPDATE ON plan, plan_version TO kora_platform;

-- Tables d'entreprise (RLS forcée)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company','company_membership','role','membership_role','invitation',
                           'numbering_sequence','outbox_event','subscription','subscription_event',
                           'platform_invoice','platform_payment','notification','support_access_grant','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- company : l'API voit l'entreprise active, et celles dont l'utilisateur est membre actif
GRANT SELECT, INSERT, UPDATE ON company TO kora_app;
CREATE POLICY company_app_select ON company FOR SELECT TO kora_app USING (
  id = app_company_id()
  OR EXISTS (SELECT 1 FROM company_membership m
             WHERE m.company_id = company.id AND m.user_id = app_user_id() AND m.status = 'active'));
CREATE POLICY company_app_insert ON company FOR INSERT TO kora_app WITH CHECK (id = app_company_id());
CREATE POLICY company_app_update ON company FOR UPDATE TO kora_app
  USING (id = app_company_id()) WITH CHECK (id = app_company_id());
GRANT SELECT, UPDATE ON company TO kora_platform;
CREATE POLICY company_platform ON company FOR ALL TO kora_platform USING (true) WITH CHECK (true);

-- company_membership : l'entreprise active, plus ses propres adhésions (sélecteur d'entreprise)
GRANT SELECT, INSERT, UPDATE, DELETE ON company_membership TO kora_app;
CREATE POLICY membership_app_select ON company_membership FOR SELECT TO kora_app
  USING (company_id = app_company_id() OR user_id = app_user_id());
CREATE POLICY membership_app_write ON company_membership FOR INSERT TO kora_app WITH CHECK (company_id = app_company_id());
CREATE POLICY membership_app_update ON company_membership FOR UPDATE TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY membership_app_delete ON company_membership FOR DELETE TO kora_app USING (company_id = app_company_id());
GRANT SELECT ON company_membership TO kora_platform;
CREATE POLICY membership_platform_select ON company_membership FOR SELECT TO kora_platform USING (true);

-- Tables strictement limitées à l'entreprise active pour l'API
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role','membership_role','invitation','numbering_sequence','outbox_event']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kora_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
-- Les rôles d'une entreprise sont aussi lisibles pour ses propres adhésions (calcul des permissions)
CREATE POLICY role_own_memberships ON role FOR SELECT TO kora_app USING (
  EXISTS (SELECT 1 FROM company_membership m WHERE m.company_id = role.company_id AND m.user_id = app_user_id()));

-- Abonnement et facturation : lecture seule pour l'entreprise, écriture par la plateforme
GRANT SELECT, INSERT ON subscription TO kora_app;
CREATE POLICY subscription_app_select ON subscription FOR SELECT TO kora_app USING (company_id = app_company_id());
CREATE POLICY subscription_app_insert ON subscription FOR INSERT TO kora_app
  WITH CHECK (company_id = app_company_id() AND status = 'trialing');
GRANT SELECT, INSERT, UPDATE ON subscription TO kora_platform;
CREATE POLICY subscription_platform ON subscription FOR ALL TO kora_platform USING (true) WITH CHECK (true);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription_event','platform_invoice','platform_payment','notification']
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO kora_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO kora_app USING (company_id = app_company_id())', t || '_app_select', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO kora_platform', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_platform USING (true) WITH CHECK (true)', t || '_platform', t);
  END LOOP;
END $$;
GRANT INSERT ON subscription_event TO kora_app;
CREATE POLICY subscription_event_app_insert ON subscription_event FOR INSERT TO kora_app WITH CHECK (company_id = app_company_id());
GRANT USAGE ON SEQUENCE platform_invoice_seq TO kora_platform;
GRANT SELECT, INSERT, UPDATE ON payment_webhook_event TO kora_platform;

-- Accès exceptionnel : demandé par la plateforme, décidé par l'entreprise
GRANT SELECT, UPDATE ON support_access_grant TO kora_app;
CREATE POLICY support_grant_app ON support_access_grant FOR ALL TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON support_access_grant TO kora_platform;
CREATE POLICY support_grant_platform ON support_access_grant FOR ALL TO kora_platform USING (true) WITH CHECK (true);

-- Journal d'audit : chaque entreprise lit le sien ; la plateforme n'y lit que ses propres événements
GRANT SELECT, INSERT ON audit_log TO kora_app, kora_platform;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO kora_app, kora_platform;
CREATE POLICY audit_app_select ON audit_log FOR SELECT TO kora_app USING (company_id = app_company_id());
CREATE POLICY audit_app_insert ON audit_log FOR INSERT TO kora_app WITH CHECK (company_id = app_company_id());
CREATE POLICY audit_platform_select ON audit_log FOR SELECT TO kora_platform USING (company_id IS NULL);
CREATE POLICY audit_platform_insert ON audit_log FOR INSERT TO kora_platform WITH CHECK (true);

-- Identité : un utilisateur ne voit que son compte et les membres de l'entreprise active.
-- Les recherches par e-mail (connexion, inscription, invitation) passent par le mode
-- « app.identity_lookup », activé explicitement par le seul code d'authentification.
CREATE OR REPLACE FUNCTION app_identity_lookup() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.identity_lookup', true), '') = 'on' $$;
GRANT EXECUTE ON FUNCTION app_identity_lookup() TO kora_app;

ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account FORCE ROW LEVEL SECURITY;
CREATE POLICY user_app_select ON user_account FOR SELECT TO kora_app USING (
  id = app_user_id() OR app_identity_lookup()
  OR EXISTS (SELECT 1 FROM company_membership m WHERE m.user_id = user_account.id AND m.company_id = app_company_id()));
CREATE POLICY user_app_insert ON user_account FOR INSERT TO kora_app WITH CHECK (app_identity_lookup());
CREATE POLICY user_app_update ON user_account FOR UPDATE TO kora_app
  USING (id = app_user_id() OR app_identity_lookup()) WITH CHECK (id = app_user_id() OR app_identity_lookup());
CREATE POLICY user_platform_select ON user_account FOR SELECT TO kora_platform USING (true);

ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_app_select ON user_session FOR SELECT TO kora_app USING (user_id = app_user_id() OR app_identity_lookup());
CREATE POLICY session_app_insert ON user_session FOR INSERT TO kora_app WITH CHECK (user_id = app_user_id() OR app_identity_lookup());
CREATE POLICY session_app_update ON user_session FOR UPDATE TO kora_app USING (
  user_id = app_user_id() OR app_identity_lookup()
  OR (active_company_id = app_company_id()
      AND EXISTS (SELECT 1 FROM company_membership m WHERE m.user_id = user_session.user_id AND m.company_id = app_company_id())));

ALTER TABLE platform_role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_role_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_role_app_select ON platform_role_assignment FOR SELECT TO kora_app USING (user_id = app_user_id() OR app_identity_lookup());
CREATE POLICY platform_role_platform ON platform_role_assignment FOR ALL TO kora_platform USING (true) WITH CHECK (true);
