-- =====================================================================
-- Kora ERP — Migration 0054 : rapprochement bancaire (fonctionnalité « bank_reconciliation », V1.2)
-- Les lignes du relevé (banque ou mobile money) sont importées puis pointées une à une avec
-- un mouvement de trésorerie de Kora. Aucun mouvement ni écriture n'est modifié par le pointage.
-- =====================================================================
CREATE TABLE bank_statement_line (
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  date        date NOT NULL,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  amount      numeric(18,2) NOT NULL CHECK (amount <> 0),   -- positif : entrée sur le compte ; négatif : sortie
  reference   text CHECK (length(reference) <= 100),
  movement_id uuid,                                         -- mouvement de Kora pointé
  ignored_at  timestamptz,                                  -- ligne écartée (doublon de relevé, opération hors Kora)
  matched_by  uuid,
  matched_at  timestamptz,
  imported_by uuid,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES treasury_account (company_id, id),
  FOREIGN KEY (company_id, movement_id) REFERENCES treasury_movement (company_id, id)
);
CREATE UNIQUE INDEX bank_statement_line_movement_uq ON bank_statement_line (company_id, movement_id) WHERE movement_id IS NOT NULL;
CREATE INDEX bank_statement_line_account_idx ON bank_statement_line (company_id, account_id, date);

ALTER TABLE bank_statement_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_line FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_statement_line_tenant ON bank_statement_line FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_statement_line TO kora_app;
GRANT SELECT ON bank_statement_line TO kora_platform;
CREATE POLICY bank_statement_line_platform ON bank_statement_line FOR SELECT TO kora_platform USING (true);
