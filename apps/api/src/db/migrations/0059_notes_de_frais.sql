-- =====================================================================
-- Kora ERP — Migration 0059 : notes de frais (fonctionnalité « expenses », V1.3)
-- Un utilisateur déclare une dépense avancée (justificatif en photo ou PDF) ; un responsable la valide
-- ou la refuse ; le remboursement crée la dépense en trésorerie (et donc l'écriture comptable).
-- =====================================================================
CREATE TABLE expense_claim (
  company_id      uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  user_id         uuid NOT NULL REFERENCES user_account(id),
  date            date NOT NULL,
  category        text NOT NULL,
  label           text NOT NULL CHECK (length(label) BETWEEN 2 AND 200),
  amount          numeric(18,2) NOT NULL CHECK (amount > 0),
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'paid')),
  decided_by      uuid REFERENCES user_account(id),
  decided_at      timestamptz,
  reject_reason   text CHECK (length(reject_reason) <= 300),
  movement_id     uuid,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (company_id, movement_id) REFERENCES treasury_movement (company_id, id)
);
CREATE INDEX expense_claim_user_idx ON expense_claim (company_id, user_id, created_at);
CREATE TABLE expense_receipt (
  company_id uuid NOT NULL,
  claim_id   uuid NOT NULL,
  mime       text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, claim_id),
  FOREIGN KEY (company_id, claim_id) REFERENCES expense_claim (company_id, id) ON DELETE CASCADE
);

ALTER TABLE expense_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_claim_tenant ON expense_claim FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_claim TO kora_app;
ALTER TABLE expense_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_receipt_tenant ON expense_receipt FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_receipt TO kora_app;
GRANT SELECT ON expense_claim TO kora_platform;
CREATE POLICY expense_claim_platform ON expense_claim FOR SELECT TO kora_platform USING (true);
