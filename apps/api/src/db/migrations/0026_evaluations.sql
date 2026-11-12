-- =====================================================================
-- Kora ERP — Migration 0026 : évaluations des employés
-- Une campagne (« Évaluation annuelle 2026 ») fixe la période et les critères notés de 1 à 5.
-- Chaque employé y reçoit une évaluation remplie par un évaluateur, soumise puis approuvée.
-- L'approbation décide d'une prime (versée avec la paie du mois choisi) et/ou d'une augmentation
-- du salaire de base (appliquée à la fiche à partir du mois choisi).
-- =====================================================================

CREATE TABLE evaluation_campaign (
  company_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  due_date     date,
  criteria     jsonb NOT NULL,              -- [{ key, label, weight }]
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by   uuid REFERENCES user_account(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CHECK (period_end >= period_start)
);
CREATE TRIGGER evaluation_campaign_touch BEFORE UPDATE ON evaluation_campaign FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE evaluation (
  company_id        uuid NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  campaign_id       uuid NOT NULL,
  employee_id       uuid NOT NULL,
  evaluator_id      uuid REFERENCES user_account(id),
  scores            jsonb NOT NULL DEFAULT '{}',   -- { clé du critère: { score 1..5, comment } }
  score             numeric(3,2) CHECK (score BETWEEN 1 AND 5),
  strengths         text,
  improvements      text,
  goals             text,
  comment           text,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','refused')),
  submitted_at      timestamptz,
  -- Proposition puis décision : prime et augmentation
  bonus_amount      numeric(18,2) NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  bonus_period      char(7) CHECK (bonus_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  new_base_salary   numeric(18,2) CHECK (new_base_salary >= 0),
  previous_base_salary numeric(18,2),
  raise_period      char(7) CHECK (raise_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  raise_applied_at  timestamptz,
  decided_by        uuid REFERENCES user_account(id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, campaign_id, employee_id),
  FOREIGN KEY (company_id, campaign_id) REFERENCES evaluation_campaign (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id),
  CHECK (bonus_amount = 0 OR bonus_period IS NOT NULL),
  CHECK (new_base_salary IS NULL OR raise_period IS NOT NULL)
);
CREATE INDEX evaluation_employee_idx ON evaluation (company_id, employee_id);
CREATE INDEX evaluation_bonus_idx ON evaluation (company_id, bonus_period) WHERE status = 'approved' AND bonus_amount > 0;
CREATE TRIGGER evaluation_touch BEFORE UPDATE ON evaluation FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evaluation_campaign','evaluation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_campaign, evaluation TO kora_app;

-- Droits du nouveau module « Évaluations » pour les rôles standard.
CREATE OR REPLACE FUNCTION pg_temp.grant_to_role(role_key text, perms text[]) RETURNS void LANGUAGE sql AS $$
  UPDATE role SET permissions = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(permissions || perms) p)
   WHERE is_system AND key = role_key;
$$;
SELECT pg_temp.grant_to_role('owner', ARRAY['evaluations.read','evaluations.create','evaluations.update','evaluations.validate','evaluations.cancel','evaluations.export','evaluations.admin']);
SELECT pg_temp.grant_to_role('director', ARRAY['evaluations.read','evaluations.create','evaluations.update','evaluations.validate']);
SELECT pg_temp.grant_to_role('hr_manager', ARRAY['evaluations.read','evaluations.create','evaluations.update','evaluations.validate','evaluations.cancel','evaluations.export']);
SELECT pg_temp.grant_to_role('payroll_manager', ARRAY['evaluations.read']);
SELECT pg_temp.grant_to_role('employee', ARRAY['evaluations.self']);
