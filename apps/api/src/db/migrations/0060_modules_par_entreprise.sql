-- =====================================================================
-- Kora ERP — Migration 0060 : modules activés ou retirés entreprise par entreprise
-- Sans ligne, un module suit la formule souscrite (situation de toutes les entreprises à
-- l'installation : rien ne change pour elles). Une ligne enabled = false retire le module
-- (menus masqués, accès refusé, données conservées) ; enabled = true l'ajoute hors formule.
-- L'entreprise lit ses propres lignes ; seule la plateforme les crée, modifie ou retire.
-- =====================================================================
CREATE TABLE company_module (
  company_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  module     text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled    boolean NOT NULL,
  changed_by uuid REFERENCES user_account(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, module)
);
ALTER TABLE company_module ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_module FORCE ROW LEVEL SECURITY;
GRANT SELECT ON company_module TO kora_app;
CREATE POLICY company_module_app ON company_module FOR SELECT TO kora_app USING (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON company_module TO kora_platform;
CREATE POLICY company_module_platform ON company_module FOR ALL TO kora_platform USING (true) WITH CHECK (true);
