-- =====================================================================
-- Kora ERP — Migration 0010 : employés et paie ivoirienne
-- Une paie mensuelle validée est intangible : ses bulletins conservent les montants
-- et les paramètres (barèmes, taux) avec lesquels ils ont été calculés.
-- =====================================================================

CREATE TABLE employee (
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  number              text NOT NULL,
  first_name          text NOT NULL CHECK (length(trim(first_name)) > 0),
  last_name           text NOT NULL CHECK (length(trim(last_name)) > 0),
  job_title           text,
  department          text,
  hire_date           date NOT NULL,
  end_date            date,
  contract_type       text NOT NULL DEFAULT 'cdi' CHECK (contract_type IN ('cdi','cdd','stage','journalier')),
  cnps_number         text,
  marital_status      text NOT NULL DEFAULT 'single' CHECK (marital_status IN ('single','married','divorced','widowed')),
  children            integer NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 20),
  parts_override      numeric(3,1) CHECK (parts_override BETWEEN 1 AND 5),
  base_salary         numeric(18,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  housing_allowance   numeric(18,2) NOT NULL DEFAULT 0 CHECK (housing_allowance >= 0),
  transport_allowance numeric(18,2) NOT NULL DEFAULT 0 CHECK (transport_allowance >= 0),
  other_allowances    numeric(18,2) NOT NULL DEFAULT 0 CHECK (other_allowances >= 0),
  payment_method      text NOT NULL DEFAULT 'bank_transfer' CHECK (payment_method IN ('cash','bank_transfer','mobile_money')),
  bank_details_enc    text,                 -- RIB ou numéro mobile money, chiffré (AES-256-GCM)
  phone               text,
  email               text,
  created_by          uuid REFERENCES user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, number),
  CHECK (end_date IS NULL OR end_date >= hire_date)
);
CREATE TRIGGER employee_touch BEFORE UPDATE ON employee FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE payroll_settings (
  company_id uuid PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
  params     jsonb NOT NULL,
  updated_by uuid REFERENCES user_account(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_run (
  company_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  period       char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated')),
  params       jsonb NOT NULL,              -- paramètres utilisés, figés à la validation
  validated_at timestamptz,
  validated_by uuid REFERENCES user_account(id),
  created_by   uuid REFERENCES user_account(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, period)
);

CREATE TABLE payslip (
  company_id    uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL,
  employee_id   uuid NOT NULL,
  employee      jsonb NOT NULL,             -- fiche de l'employé figée (nom, poste, parts, CNPS…)
  inputs        jsonb NOT NULL,             -- éléments variables du mois
  lines         jsonb NOT NULL,
  totals        jsonb NOT NULL,
  gross         numeric(18,2) NOT NULL,
  taxable       numeric(18,2) NOT NULL,
  net           numeric(18,2) NOT NULL CHECK (net >= 0),
  employer_cost numeric(18,2) NOT NULL,
  paid_at       date,
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, run_id, employee_id),
  FOREIGN KEY (company_id, run_id) REFERENCES payroll_run (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id)
);

-- Intangibilité d'une paie validée (seule la date de paiement d'un bulletin peut être posée ensuite)
CREATE OR REPLACE FUNCTION payroll_run_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'validated' THEN RAISE EXCEPTION 'paie validée : suppression interdite' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'validated' THEN RAISE EXCEPTION 'paie validée : modification interdite' USING ERRCODE = 'check_violation'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER payroll_run_lock BEFORE UPDATE OR DELETE ON payroll_run FOR EACH ROW EXECUTE FUNCTION payroll_run_lock();

CREATE OR REPLACE FUNCTION payslip_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM payroll_run WHERE company_id = coalesce(NEW.company_id, OLD.company_id) AND id = coalesce(NEW.run_id, OLD.run_id);
  IF st = 'validated' THEN
    IF TG_OP = 'UPDATE' AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL AND (to_jsonb(NEW) - 'paid_at') = (to_jsonb(OLD) - 'paid_at') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'paie validée : bulletin non modifiable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER payslip_lock BEFORE INSERT OR UPDATE OR DELETE ON payslip FOR EACH ROW EXECUTE FUNCTION payslip_lock();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee','payroll_settings','payroll_run','payslip']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON employee, payroll_settings TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_run, payslip TO kora_app;

-- Paiement des salaires depuis la trésorerie, et écritures de paie
ALTER TABLE treasury_movement DROP CONSTRAINT treasury_movement_source_type_check;
ALTER TABLE treasury_movement ADD CONSTRAINT treasury_movement_source_type_chk
  CHECK (source_type IN ('sales_payment','purchase_payment','sales_refund','payroll','expense','income','transfer','cash_count','reversal'));
ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_chk;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_chk
  CHECK (source_type IN ('manual','sales_document','purchase_document','treasury_movement','treasury_opening','stock_opening','stock_variation','payroll_run','reversal'));

-- Compte de la CMU, ajouté au plan comptable des entreprises existantes et futures
INSERT INTO ledger_account (company_id, code, name, is_system)
SELECT id, '438', 'Autres organismes sociaux (CMU)', true FROM company ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION seed_accounting_extra(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system) VALUES (p_company, '438', 'Autres organismes sociaux (CMU)', true) ON CONFLICT DO NOTHING;
$$;
GRANT EXECUTE ON FUNCTION seed_accounting_extra(uuid) TO kora_app;

-- Le propriétaire dispose de tous les droits de paie (il n'avait que consulter, valider, exporter)
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(permissions || ARRAY['payroll.create','payroll.update','payroll.cancel','payroll.admin']) p)
 WHERE is_system AND key = 'owner';
