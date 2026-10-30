-- =====================================================================
-- Kora ERP — Migration 0003 : articles, devis, factures et encaissements
-- Un document est un brouillon modifiable tant qu'il n'est pas validé.
-- À la validation il reçoit son numéro définitif (séquence annuelle sans trou)
-- et devient intangible : la base refuse toute modification de son contenu.
-- =====================================================================

CREATE TABLE product (
  company_id     uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  code           text NOT NULL CHECK (length(trim(code)) > 0),
  kind           text NOT NULL DEFAULT 'good' CHECK (kind IN ('good','service')),
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  description    text,
  unit           text NOT NULL DEFAULT 'unité',
  sale_price     numeric(18,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  purchase_price numeric(18,2) CHECK (purchase_price >= 0),
  vat_rate       numeric(5,2) NOT NULL DEFAULT 18 CHECK (vat_rate BETWEEN 0 AND 100),
  archived_at    timestamptz,
  created_by     uuid REFERENCES user_account(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, code)
);
CREATE INDEX product_name_idx ON product (company_id, lower(name));
CREATE TRIGGER product_touch BEFORE UPDATE ON product FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE sales_document (
  company_id      uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type IN ('quote','invoice')),
  status          text NOT NULL DEFAULT 'draft',
  number          text,
  contact_id      uuid NOT NULL,
  customer        jsonb NOT NULL DEFAULT '{}',   -- coordonnées du client figées à la validation
  issue_date      date NOT NULL DEFAULT current_date,
  due_date        date,                          -- facture : échéance
  valid_until     date,                          -- devis : fin de validité
  currency        char(3) NOT NULL DEFAULT 'XOF',
  notes           text,
  total_ht        numeric(18,2) NOT NULL DEFAULT 0,
  total_vat       numeric(18,2) NOT NULL DEFAULT 0,
  total_ttc       numeric(18,2) NOT NULL DEFAULT 0,
  paid_amount     numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= total_ttc),
  source_quote_id uuid,
  validated_at    timestamptz,
  validated_by    uuid REFERENCES user_account(id),
  created_by      uuid REFERENCES user_account(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, source_quote_id) REFERENCES sales_document (company_id, id),
  CHECK ((type = 'quote' AND status IN ('draft','sent','accepted','refused','invoiced'))
      OR (type = 'invoice' AND status IN ('draft','issued','partially_paid','paid'))),
  CHECK ((status = 'draft') = (number IS NULL))
);
CREATE INDEX sales_document_list_idx ON sales_document (company_id, type, issue_date DESC);
CREATE TRIGGER sales_document_touch BEFORE UPDATE ON sales_document FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE sales_document_line (
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
  FOREIGN KEY (company_id, document_id) REFERENCES sales_document (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id)
);
CREATE INDEX sales_document_line_doc_idx ON sales_document_line (company_id, document_id, position);

CREATE TABLE sales_payment (
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
  FOREIGN KEY (company_id, document_id) REFERENCES sales_document (company_id, id)
);

-- Intangibilité des documents validés (exigence légale pour les factures)
CREATE OR REPLACE FUNCTION sales_document_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'document validé : suppression interdite' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.number, NEW.type, NEW.contact_id, NEW.customer, NEW.issue_date, NEW.due_date, NEW.total_ht, NEW.total_vat, NEW.total_ttc, NEW.currency)
     IS DISTINCT FROM (OLD.number, OLD.type, OLD.contact_id, OLD.customer, OLD.issue_date, OLD.due_date, OLD.total_ht, OLD.total_vat, OLD.total_ttc, OLD.currency) THEN
    RAISE EXCEPTION 'document validé : contenu non modifiable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_document_lock BEFORE UPDATE OR DELETE ON sales_document FOR EACH ROW EXECUTE FUNCTION sales_document_lock();

CREATE OR REPLACE FUNCTION sales_line_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM sales_document
   WHERE company_id = coalesce(NEW.company_id, OLD.company_id) AND id = coalesce(NEW.document_id, OLD.document_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'document validé : lignes non modifiables' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER sales_line_lock BEFORE INSERT OR UPDATE OR DELETE ON sales_document_line FOR EACH ROW EXECUTE FUNCTION sales_line_lock();

-- Sécurité au niveau des lignes : entreprise active uniquement
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product','sales_document','sales_document_line','sales_payment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON product TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_document, sales_document_line TO kora_app;
GRANT SELECT, INSERT ON sales_payment TO kora_app;   -- un encaissement ne se modifie pas

-- Nouveau module « Articles » : droits ajoutés aux rôles standard existants
CREATE OR REPLACE FUNCTION pg_temp.grant_to_role(role_key text, perms text[]) RETURNS void LANGUAGE sql AS $$
  UPDATE role SET permissions = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(permissions || perms) p)
   WHERE is_system AND key = role_key;
$$;
SELECT pg_temp.grant_to_role('owner', ARRAY['products.read','products.create','products.update','products.cancel','products.export','products.admin']);
SELECT pg_temp.grant_to_role('director', ARRAY['products.read','products.export']);
SELECT pg_temp.grant_to_role('accountant', ARRAY['products.read','products.create','products.update','products.export']);
SELECT pg_temp.grant_to_role('finance_manager', ARRAY['products.read','products.export']);
SELECT pg_temp.grant_to_role('cashier', ARRAY['products.read']);
SELECT pg_temp.grant_to_role('sales_rep', ARRAY['products.read']);
SELECT pg_temp.grant_to_role('auditor', ARRAY['products.read','products.export']);
