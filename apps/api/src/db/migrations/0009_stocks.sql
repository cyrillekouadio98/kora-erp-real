-- =====================================================================
-- Kora ERP — Migration 0009 : stocks
-- Quantités et valeur par article, valorisées au coût moyen unitaire pondéré (CMUP).
-- Chaque entrée ou sortie est un mouvement en ajout seul. La base interdit un stock négatif.
-- =====================================================================

ALTER TABLE product
  ADD COLUMN track_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN min_stock   numeric(18,3) CHECK (min_stock >= 0),          -- seuil d'alerte
  ADD COLUMN stock_qty   numeric(18,3) NOT NULL DEFAULT 0,
  ADD COLUMN stock_value numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN avg_cost    numeric(18,4) NOT NULL DEFAULT 0,              -- dernier CMUP connu
  ADD CONSTRAINT product_stock_service_chk CHECK (NOT track_stock OR kind = 'good'),
  ADD CONSTRAINT product_stock_positive_chk CHECK (stock_qty >= 0 AND stock_value >= 0);
-- Les biens existants sont suivis en stock à partir de maintenant (stock initial à saisir).
UPDATE product SET track_stock = true WHERE kind = 'good';

CREATE TABLE stock_movement (
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL,
  date        date NOT NULL DEFAULT current_date,
  direction   text NOT NULL CHECK (direction IN ('in','out')),
  quantity    numeric(18,3) NOT NULL CHECK (quantity > 0),
  value       numeric(18,2) NOT NULL CHECK (value >= 0),             -- valeur du mouvement au coût d'entrée ou au CMUP
  qty_after   numeric(18,3) NOT NULL CHECK (qty_after >= 0),
  value_after numeric(18,2) NOT NULL CHECK (value_after >= 0),
  reason      text NOT NULL CHECK (reason IN ('opening','purchase','sale','sale_return','adjustment')),
  source_id   uuid,                                                   -- facture, avoir
  label       text NOT NULL,
  created_by  uuid REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id)
);
CREATE INDEX stock_movement_product_idx ON stock_movement (company_id, product_id, date, created_at);

CREATE OR REPLACE FUNCTION stock_movement_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'mouvement de stock : ajout seul (passez un ajustement)' USING ERRCODE = 'check_violation'; END $$;
CREATE TRIGGER stock_movement_lock BEFORE UPDATE OR DELETE ON stock_movement FOR EACH ROW EXECUTE FUNCTION stock_movement_lock();

-- Avoir : les marchandises reviennent-elles en stock ? (non pour une simple remise de prix)
ALTER TABLE sales_document ADD COLUMN restock boolean NOT NULL DEFAULT true;

-- Écriture de stock initial (D 311 / C 471)
ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_chk;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_chk
  CHECK (source_type IN ('manual','sales_document','purchase_document','treasury_movement','treasury_opening','stock_opening','stock_variation','reversal'));

ALTER TABLE stock_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movement_tenant ON stock_movement FOR ALL TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON stock_movement TO kora_app;
