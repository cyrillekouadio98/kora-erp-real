-- =====================================================================
-- Kora ERP — Migration 0030 : logo de l'entreprise
-- Image réduite par le navigateur (proportions gardées), rangée à part comme les logos des contacts ;
-- elle figure sur les devis, factures, bons de commande et bulletins.
-- =====================================================================

CREATE TABLE company_logo (
  company_id  uuid PRIMARY KEY REFERENCES company (id) ON DELETE CASCADE,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data        bytea NOT NULL CHECK (octet_length(data) <= 300000),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_logo ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_logo FORCE ROW LEVEL SECURITY;
CREATE POLICY company_logo_tenant ON company_logo FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON company_logo TO kora_app;
