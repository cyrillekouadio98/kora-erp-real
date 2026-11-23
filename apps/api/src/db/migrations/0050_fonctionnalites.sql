-- =====================================================================
-- Kora ERP — Migration 0050 : fonctionnalités activées entreprise par entreprise
-- Les nouveautés (à partir de la V1.2) sont désactivées partout ; l'éditeur les active
-- à la demande d'un client depuis la console. Une ligne = une fonctionnalité active.
-- L'entreprise lit ses propres lignes ; seule la plateforme les crée ou les retire.
-- =====================================================================
CREATE TABLE company_feature (
  company_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  feature    text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled_by uuid REFERENCES user_account(id),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, feature)
);
ALTER TABLE company_feature ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_feature FORCE ROW LEVEL SECURITY;
GRANT SELECT ON company_feature TO kora_app;
CREATE POLICY company_feature_app ON company_feature FOR SELECT TO kora_app USING (company_id = app_company_id());
GRANT SELECT, INSERT, DELETE ON company_feature TO kora_platform;
CREATE POLICY company_feature_platform ON company_feature FOR ALL TO kora_platform USING (true) WITH CHECK (true);
