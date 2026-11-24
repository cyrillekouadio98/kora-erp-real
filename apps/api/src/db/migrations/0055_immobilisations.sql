-- =====================================================================
-- Kora ERP — Migration 0055 : immobilisations et amortissements (fonctionnalité « fixed_assets », V1.2)
-- Registre des biens durables (véhicules, matériel, mobilier, logiciels, bâtiments), plan
-- d'amortissement linéaire au prorata temporis, dotations annuelles (D 681 / C 28x) et sortie
-- de l'actif (D 28x, D 812 / C 2x). Rien n'est passé tant que la fonctionnalité n'est pas activée.
-- =====================================================================

-- Comptes SYSCOHADA nécessaires, pour toutes les entreprises et les suivantes.
CREATE OR REPLACE FUNCTION seed_accounting_assets(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system)
  SELECT p_company, code, name, true FROM (VALUES
    ('481000', 'Fournisseurs d''investissements'),
    ('681200', 'Dotations aux amortissements des immobilisations incorporelles'),
    ('681300', 'Dotations aux amortissements des immobilisations corporelles'),
    ('812000', 'Valeurs comptables des cessions d''immobilisations'),
    ('822000', 'Produits des cessions d''immobilisations')
  ) AS chart(code, name)
  ON CONFLICT DO NOTHING;
$$;
GRANT EXECUTE ON FUNCTION seed_accounting_assets(uuid) TO kora_app;
SELECT seed_accounting_assets(id) FROM company WHERE EXISTS (SELECT 1 FROM ledger_account a WHERE a.company_id = company.id);

CREATE OR REPLACE FUNCTION seed_accounting_extra(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system) VALUES (p_company, '438000', 'Autres organismes sociaux (CMU)', true) ON CONFLICT DO NOTHING;
  SELECT seed_accounting_formation(p_company);
  SELECT seed_accounting_assets(p_company);
$$;

CREATE TABLE fixed_asset (
  company_id             uuid NOT NULL,
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  code                   text NOT NULL,
  name                   text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  category               text NOT NULL,
  asset_account          text NOT NULL,
  depreciation_account   text NOT NULL,
  expense_account        text NOT NULL,
  acquisition_date       date NOT NULL,
  in_service_date        date NOT NULL CHECK (in_service_date >= acquisition_date),
  cost                   numeric(18,2) NOT NULL CHECK (cost > 0),
  duration_months        integer NOT NULL CHECK (duration_months BETWEEN 1 AND 1200),
  prior_depreciation     numeric(18,2) NOT NULL DEFAULT 0 CHECK (prior_depreciation >= 0),
  posting                text NOT NULL CHECK (posting IN ('none', 'supplier', 'opening')),
  acquisition_entry_id   uuid,
  disposed_on            date,
  disposal_entry_id      uuid,
  notes                  text,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, code),
  CHECK (prior_depreciation <= cost)
);
CREATE TABLE fixed_asset_depreciation (
  company_id uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_id   uuid NOT NULL,
  year       integer NOT NULL,
  amount     numeric(18,2) NOT NULL CHECK (amount > 0),
  entry_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, asset_id, year),
  FOREIGN KEY (company_id, asset_id) REFERENCES fixed_asset (company_id, id)
);

ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_chk;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_chk
  CHECK (source_type IN ('manual','sales_document','purchase_document','treasury_movement','treasury_opening','stock_opening','stock_variation','payroll_run','year_closing','formation','fixed_asset','reversal'));

ALTER TABLE fixed_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset FORCE ROW LEVEL SECURITY;
CREATE POLICY fixed_asset_tenant ON fixed_asset FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON fixed_asset TO kora_app;
ALTER TABLE fixed_asset_depreciation ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_depreciation FORCE ROW LEVEL SECURITY;
CREATE POLICY fixed_asset_depreciation_tenant ON fixed_asset_depreciation FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON fixed_asset_depreciation TO kora_app;
GRANT SELECT ON fixed_asset TO kora_platform;
CREATE POLICY fixed_asset_platform ON fixed_asset FOR SELECT TO kora_platform USING (true);
