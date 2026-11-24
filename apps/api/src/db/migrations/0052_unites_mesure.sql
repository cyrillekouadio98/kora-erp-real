-- =====================================================================
-- Kora ERP — Migration 0052 : unités de mesure (fonctionnalité « units », V1.2)
-- Le stock reste tenu dans l'unité de l'article (ex. kg). Une ligne de vente ou d'achat peut
-- être saisie dans une autre unité (sac de 50 kg, carton de 12) : la ligne garde le nom de
-- l'unité et son coefficient, et le stock bouge de quantité × coefficient.
-- Coefficient 1 par défaut : aucun document existant ne change.
-- =====================================================================
CREATE TABLE product_unit (
  company_id     uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 20),
  factor         numeric(18,6) NOT NULL CHECK (factor > 0),
  sale_price     numeric(18,2) CHECK (sale_price >= 0),
  purchase_price numeric(18,2) CHECK (purchase_price >= 0),
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, product_id, name),
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id)
);
ALTER TABLE product_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY product_unit_tenant ON product_unit FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON product_unit TO kora_app;
GRANT SELECT ON product_unit TO kora_platform;
CREATE POLICY product_unit_platform ON product_unit FOR SELECT TO kora_platform USING (true);

ALTER TABLE sales_document_line ADD COLUMN unit_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (unit_factor > 0);
ALTER TABLE purchase_document_line ADD COLUMN unit_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (unit_factor > 0);
