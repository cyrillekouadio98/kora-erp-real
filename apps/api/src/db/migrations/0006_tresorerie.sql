-- =====================================================================
-- Kora ERP — Migration 0006 : trésorerie (caisse, banque, mobile money)
-- Chaque entrée ou sortie d'argent est un mouvement sur un compte de trésorerie.
-- Les mouvements sont en ajout seul : une erreur se corrige par contre-passation.
-- =====================================================================

CREATE TABLE treasury_account (
  company_id      uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('cash','bank','mobile_money')),
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  bank_name       text,                 -- banque ou opérateur (SGCI, Ecobank, Orange Money, Wave…)
  account_number  text,                 -- RIB ou numéro de téléphone du compte marchand
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  opening_date    date NOT NULL DEFAULT current_date,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, name),
  CONSTRAINT treasury_cash_opening_chk CHECK (kind <> 'cash' OR opening_balance >= 0)
);
CREATE TRIGGER treasury_account_touch BEFORE UPDATE ON treasury_account FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE treasury_movement (
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  date        date NOT NULL DEFAULT current_date,
  direction   text NOT NULL CHECK (direction IN ('in','out')),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  category    text NOT NULL,
  label       text NOT NULL CHECK (length(trim(label)) > 0),
  contact_id  uuid,
  source_type text NOT NULL CHECK (source_type IN ('sales_payment','purchase_payment','sales_refund','expense','income','transfer','cash_count','reversal')),
  source_id   uuid,                    -- encaissement, règlement ou facture à l'origine du mouvement
  transfer_id uuid,                    -- relie les deux jambes d'un virement interne
  reversal_of uuid,                    -- mouvement annulé par celui-ci
  reversed_by uuid,                    -- contre-passation qui annule ce mouvement
  reference   text,
  created_by  uuid REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES treasury_account (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, reversal_of) REFERENCES treasury_movement (company_id, id),
  FOREIGN KEY (company_id, reversed_by) REFERENCES treasury_movement (company_id, id)
);
CREATE INDEX treasury_movement_account_idx ON treasury_movement (company_id, account_id, date, created_at);
CREATE UNIQUE INDEX treasury_movement_reversal_uq ON treasury_movement (company_id, reversal_of) WHERE reversal_of IS NOT NULL;

-- Ajout seul : seule l'inscription de la contre-passation est autorisée après coup.
CREATE OR REPLACE FUNCTION treasury_movement_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mouvement de trésorerie : suppression interdite (contre-passez-le)' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.reversed_by IS NULL AND NEW.reversed_by IS NOT NULL
     AND (to_jsonb(NEW) - 'reversed_by') = (to_jsonb(OLD) - 'reversed_by') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'mouvement de trésorerie : modification interdite (contre-passez-le)' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER treasury_movement_lock BEFORE UPDATE OR DELETE ON treasury_movement FOR EACH ROW EXECUTE FUNCTION treasury_movement_lock();

-- Remboursement des trop-perçus clients
ALTER TABLE sales_document ADD COLUMN refunded_amount numeric(18,2) NOT NULL DEFAULT 0
  CONSTRAINT sales_document_refunded_chk CHECK (refunded_amount >= 0);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['treasury_account','treasury_movement']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON treasury_account, treasury_movement TO kora_app;

-- Comptes par défaut des entreprises existantes, et reprise des paiements déjà enregistrés
INSERT INTO treasury_account (company_id, kind, name)
SELECT c.id, k.kind, k.name FROM company c
CROSS JOIN (VALUES ('cash','Caisse principale'), ('bank','Banque principale'), ('mobile_money','Mobile money')) AS k(kind, name);

INSERT INTO treasury_movement (company_id, account_id, date, direction, amount, category, label, contact_id, source_type, source_id, reference, created_by, created_at)
SELECT p.company_id, a.id, p.paid_on, 'in', p.amount, 'customer_payment', 'Encaissement ' || d.number, d.contact_id, 'sales_payment', p.id, p.reference, p.created_by, p.created_at
FROM sales_payment p
JOIN sales_document d ON d.company_id = p.company_id AND d.id = p.document_id
JOIN treasury_account a ON a.company_id = p.company_id
 AND a.kind = CASE p.method WHEN 'cash' THEN 'cash' WHEN 'mobile_money' THEN 'mobile_money' ELSE 'bank' END;

INSERT INTO treasury_movement (company_id, account_id, date, direction, amount, category, label, contact_id, source_type, source_id, reference, created_by, created_at)
SELECT p.company_id, a.id, p.paid_on, 'out', p.amount, 'supplier_payment', 'Règlement ' || d.number, d.contact_id, 'purchase_payment', p.id, p.reference, p.created_by, p.created_at
FROM purchase_payment p
JOIN purchase_document d ON d.company_id = p.company_id AND d.id = p.document_id
JOIN treasury_account a ON a.company_id = p.company_id
 AND a.kind = CASE p.method WHEN 'cash' THEN 'cash' WHEN 'mobile_money' THEN 'mobile_money' ELSE 'bank' END;
