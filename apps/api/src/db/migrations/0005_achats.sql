-- =====================================================================
-- Kora ERP — Migration 0005 : achats (bons de commande, factures et règlements fournisseurs)
-- Une facture fournisseur est saisie d'après le document reçu (référence et date du
-- fournisseur) ; à la validation elle reçoit un numéro interne ACH-AAAA-NNNNN et devient
-- intangible. La même facture d'un fournisseur ne peut pas être enregistrée deux fois.
-- =====================================================================

CREATE TABLE purchase_document (
  company_id      uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  type            text NOT NULL CONSTRAINT purchase_document_type_chk CHECK (type IN ('order','invoice')),
  status          text NOT NULL DEFAULT 'draft',
  number          text,
  contact_id      uuid NOT NULL,
  supplier        jsonb NOT NULL DEFAULT '{}',   -- coordonnées du fournisseur figées à la validation
  supplier_ref    text,                          -- numéro de la facture chez le fournisseur
  issue_date      date NOT NULL DEFAULT current_date,
  due_date        date,                          -- facture : échéance de paiement
  expected_date   date,                          -- commande : livraison prévue
  currency        char(3) NOT NULL DEFAULT 'XOF',
  notes           text,
  total_ht        numeric(18,2) NOT NULL DEFAULT 0,
  total_vat       numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc       numeric(18,2) NOT NULL DEFAULT 0,
  paid_amount     numeric(18,2) NOT NULL DEFAULT 0,
  source_order_id uuid,
  validated_at    timestamptz,
  validated_by    uuid REFERENCES user_account(id),
  created_by      uuid REFERENCES user_account(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  CONSTRAINT purchase_document_source_order_fk FOREIGN KEY (company_id, source_order_id) REFERENCES purchase_document (company_id, id),
  CONSTRAINT purchase_document_status_chk CHECK (
       (type = 'order' AND status IN ('draft','sent','cancelled','invoiced'))
    OR (type = 'invoice' AND status IN ('draft','to_pay','partially_paid','paid'))),
  CONSTRAINT purchase_document_number_chk CHECK ((status = 'draft') = (number IS NULL)),
  CONSTRAINT purchase_document_paid_chk CHECK (paid_amount >= 0 AND paid_amount <= total_ttc),
  CONSTRAINT purchase_document_ref_chk CHECK (type <> 'invoice' OR status = 'draft' OR length(trim(supplier_ref)) > 0)
);
CREATE INDEX purchase_document_list_idx ON purchase_document (company_id, type, issue_date DESC);
CREATE UNIQUE INDEX purchase_invoice_supplier_ref_uq ON purchase_document (company_id, contact_id, lower(trim(supplier_ref)))
  WHERE type = 'invoice' AND status <> 'draft';
CREATE TRIGGER purchase_document_touch BEFORE UPDATE ON purchase_document FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_document_line (
  company_id   uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL,
  position     integer NOT NULL,
  product_id   uuid,
  description  text NOT NULL CHECK (length(trim(description)) > 0),
  quantity     numeric(18,3) NOT NULL CHECK (quantity > 0),
  unit         text,
  unit_price   numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  vat_rate     numeric(5,2) NOT NULL CHECK (vat_rate BETWEEN 0 AND 100),
  total_ht     numeric(18,2) NOT NULL,
  total_vat    numeric(18,2) NOT NULL,
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES purchase_document (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id)
);
CREATE INDEX purchase_document_line_doc_idx ON purchase_document_line (company_id, document_id, position);

CREATE TABLE purchase_payment (
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_on     date NOT NULL DEFAULT current_date,
  method      text NOT NULL CHECK (method IN ('cash','mobile_money','bank_transfer','cheque','card')),
  reference   text,
  created_by  uuid REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES purchase_document (company_id, id)
);

-- Intangibilité des documents validés
CREATE OR REPLACE FUNCTION purchase_document_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'document validé : suppression interdite' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.number, NEW.type, NEW.contact_id, NEW.supplier, NEW.supplier_ref, NEW.issue_date, NEW.due_date, NEW.total_ht, NEW.total_vat, NEW.total_ttc, NEW.currency)
     IS DISTINCT FROM (OLD.number, OLD.type, OLD.contact_id, OLD.supplier, OLD.supplier_ref, OLD.issue_date, OLD.due_date, OLD.total_ht, OLD.total_vat, OLD.total_ttc, OLD.currency) THEN
    RAISE EXCEPTION 'document validé : contenu non modifiable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_document_lock BEFORE UPDATE OR DELETE ON purchase_document FOR EACH ROW EXECUTE FUNCTION purchase_document_lock();

CREATE OR REPLACE FUNCTION purchase_line_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM purchase_document
   WHERE company_id = coalesce(NEW.company_id, OLD.company_id) AND id = coalesce(NEW.document_id, OLD.document_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'document validé : lignes non modifiables' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER purchase_line_lock BEFORE INSERT OR UPDATE OR DELETE ON purchase_document_line FOR EACH ROW EXECUTE FUNCTION purchase_line_lock();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_document','purchase_document_line','purchase_payment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_document, purchase_document_line TO kora_app;
GRANT SELECT, INSERT ON purchase_payment TO kora_app;
