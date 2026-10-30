-- =====================================================================
-- Kora ERP — Migration 0002 : contacts (clients et fournisseurs)
-- Premier module métier (phase 3) : référentiel des tiers utilisé ensuite
-- par les ventes, les achats et la comptabilité (comptes 411 / 401).
-- Pas de suppression : un tiers est archivé, pour préserver l'historique.
-- =====================================================================

CREATE TABLE contact (
  company_id         uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  code               text NOT NULL CHECK (length(trim(code)) > 0),
  kind               text NOT NULL CHECK (kind IN ('customer','supplier','both')),
  legal_type         text NOT NULL DEFAULT 'company' CHECK (legal_type IN ('company','individual')),
  name               text NOT NULL CHECK (length(trim(name)) > 0),
  tax_id             text,              -- numéro de compte contribuable (NCC)
  rccm               text,
  email              text CHECK (email IS NULL OR email = lower(email)),
  phone              text,
  address            text,
  city               text,
  country_code       char(2) NOT NULL DEFAULT 'CI',
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  notes              text,
  archived_at        timestamptz,
  created_by         uuid REFERENCES user_account(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, code)
);
CREATE INDEX contact_name_idx ON contact (company_id, lower(name));
CREATE TRIGGER contact_touch BEFORE UPDATE ON contact FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON contact TO kora_app;
CREATE POLICY contact_tenant ON contact FOR ALL TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
