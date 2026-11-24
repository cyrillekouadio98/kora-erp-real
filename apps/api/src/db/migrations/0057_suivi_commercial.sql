-- =====================================================================
-- Kora ERP — Migration 0057 : suivi commercial (fonctionnalité « crm », V1.3)
-- Opportunités (prospect ou client, montant espéré, étape, commercial, devis lié) et leurs actions
-- (appel, rendez-vous, e-mail, note, tâche à faire). Aucun document de vente n'est modifié.
-- =====================================================================
CREATE TABLE opportunity (
  company_id      uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  contact_id      uuid,
  prospect_name   text CHECK (length(prospect_name) <= 160),   -- prospect pas encore enregistré comme contact
  prospect_phone  text CHECK (length(prospect_phone) <= 40),
  prospect_email  text CHECK (length(prospect_email) <= 254),
  stage           text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'qualified', 'quote', 'negotiation', 'won', 'lost')),
  amount          numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  expected_close  date,
  owner_id        uuid,
  source          text CHECK (length(source) <= 60),
  quote_id        uuid,
  lost_reason     text CHECK (length(lost_reason) <= 300),
  notes           text,
  closed_at       timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, code),
  CHECK (contact_id IS NOT NULL OR prospect_name IS NOT NULL),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, quote_id) REFERENCES sales_document (company_id, id)
);
CREATE TRIGGER opportunity_touch BEFORE UPDATE ON opportunity FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TABLE opportunity_activity (
  company_id     uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('call', 'meeting', 'email', 'note', 'task')),
  note           text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  due_date       date,                                     -- action à faire (relance, rendez-vous prévu)
  done_at        timestamptz,
  user_id        uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, opportunity_id) REFERENCES opportunity (company_id, id) ON DELETE CASCADE
);
CREATE INDEX opportunity_activity_due_idx ON opportunity_activity (company_id, due_date) WHERE done_at IS NULL;

ALTER TABLE opportunity ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity FORCE ROW LEVEL SECURITY;
CREATE POLICY opportunity_tenant ON opportunity FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON opportunity TO kora_app;
ALTER TABLE opportunity_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY opportunity_activity_tenant ON opportunity_activity FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_activity TO kora_app;
GRANT SELECT ON opportunity TO kora_platform;
CREATE POLICY opportunity_platform ON opportunity FOR SELECT TO kora_platform USING (true);
