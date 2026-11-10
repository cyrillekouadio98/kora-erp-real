-- =====================================================================
-- Kora ERP — Migration 0035 : écritures de constitution de la société (SYSCOHADA révisé)
-- Une fiche de constitution (forme juridique, capital, apports en nature et en numéraire, part libérée,
-- dépôt des fonds en banque ou chez le notaire) et ses étapes : souscription, appel, réalisation des
-- apports, déblocage des fonds, capital non appelé, frais de constitution, appel et versement du solde.
-- Les écritures d'OD vont au journal OD ; les versements et frais en banque sont des mouvements de
-- trésorerie (journal TR), dont la contrepartie est le compte d'apporteur ou de charge de l'étape.
-- =====================================================================

-- Comptes de constitution, pour toutes les entreprises et les suivantes.
CREATE OR REPLACE FUNCTION seed_accounting_formation(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system)
  SELECT p_company, code, name, true FROM (VALUES
    ('101100', 'Capital souscrit, non appelé'), ('101200', 'Capital souscrit, appelé, non versé'), ('101300', 'Capital souscrit, appelé, versé, non amorti'),
    ('109000', 'Apporteurs, capital souscrit, non appelé'), ('461000', 'Apporteurs, opérations sur le capital'),
    ('461100', 'Apporteurs, apports en nature'), ('461200', 'Apporteurs, apports en numéraire'), ('461300', 'Apporteurs, capital appelé, non versé'),
    ('471100', 'Notaire, fonds de constitution'), ('632400', 'Honoraires des professions réglementées'), ('632500', 'Frais d''actes et de contentieux')
  ) AS chart(code, name)
  ON CONFLICT DO NOTHING;
$$;
GRANT EXECUTE ON FUNCTION seed_accounting_formation(uuid) TO kora_app;
SELECT seed_accounting_formation(id) FROM company WHERE EXISTS (SELECT 1 FROM ledger_account a WHERE a.company_id = company.id);

CREATE OR REPLACE FUNCTION seed_accounting_extra(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system) VALUES (p_company, '438000', 'Autres organismes sociaux (CMU)', true) ON CONFLICT DO NOTHING;
  SELECT seed_accounting_formation(p_company);
$$;

-- Fiche de constitution : une par entreprise.
CREATE TABLE company_formation (
  company_id      uuid PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
  legal_form      text NOT NULL CHECK (legal_form IN ('SA','SAS','SASU','SARL','SARLU','SNC','SCS','GIE','other')),
  formation_date  date NOT NULL,
  capital         numeric(18,2) NOT NULL CHECK (capital > 0),
  -- Apports en nature : [{ account, label, amount }] (comptes d'immobilisations ou de stocks).
  nature          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Part du numéraire libérée (versée) à la constitution.
  cash_paid       numeric(18,2) NOT NULL DEFAULT 0 CHECK (cash_paid >= 0),
  deposit         text NOT NULL DEFAULT 'bank' CHECK (deposit IN ('bank','notary')),
  bank_account_id uuid,
  updated_by      uuid REFERENCES user_account(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES treasury_account (company_id, id)
);

-- Étapes passées : les écritures d'OD et les mouvements de trésorerie qu'elles ont créés.
CREATE TABLE company_formation_step (
  company_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  step         text NOT NULL CHECK (step IN ('subscription','call','contribution','release','uncalled','fees','balance_call','balance_payment')),
  date         date NOT NULL,
  amount       numeric(18,2) NOT NULL DEFAULT 0,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_ids    uuid[] NOT NULL DEFAULT '{}',
  movement_ids uuid[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES user_account(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_by uuid REFERENCES user_account(id),
  cancelled_at timestamptz,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX company_formation_step_idx ON company_formation_step (company_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_formation','company_formation_step'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON company_formation, company_formation_step TO kora_app;

-- Écritures et mouvements de constitution.
ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_chk;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_chk
  CHECK (source_type IN ('manual','sales_document','purchase_document','treasury_movement','treasury_opening','stock_opening','stock_variation','payroll_run','year_closing','formation','reversal'));
ALTER TABLE treasury_movement DROP CONSTRAINT treasury_movement_source_type_chk;
ALTER TABLE treasury_movement ADD CONSTRAINT treasury_movement_source_type_chk
  CHECK (source_type IN ('sales_payment','purchase_payment','sales_refund','payroll','expense','income','transfer','cash_count','stock_purchase','formation','reversal'));
-- Contrepartie imposée (compte d'apporteur, notaire, charge) au lieu de celle de la catégorie.
ALTER TABLE treasury_movement ADD COLUMN counterpart_code text CHECK (counterpart_code IS NULL OR counterpart_code ~ '^[1-9][0-9]{5}$');
