-- =====================================================================
-- Kora ERP — Migration 0051 : lots et dates de péremption (fonctionnalité « stock_lots », V1.2)
-- Inactive tant que l'éditeur ne l'a pas activée pour l'entreprise : les colonnes ajoutées restent
-- vides et aucun calcul existant ne change. La valorisation reste au coût moyen (CMUP) :
-- les lots ne suivent que les quantités et les dates.
-- =====================================================================
ALTER TABLE product ADD COLUMN track_lots boolean NOT NULL DEFAULT false;

-- Quantité restante de chaque lot, par entrepôt.
CREATE TABLE stock_lot (
  company_id   uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  lot_number   text NOT NULL CHECK (length(lot_number) BETWEEN 1 AND 60),
  expiry_date  date,
  quantity     numeric(18,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE NULLS NOT DISTINCT (company_id, product_id, warehouse_id, lot_number, expiry_date),
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouse (company_id, id)
);
CREATE INDEX stock_lot_expiry_idx ON stock_lot (company_id, expiry_date) WHERE quantity > 0;

-- Répartition de chaque mouvement entre les lots (sortie au plus tôt périmé d'abord, retour au même lot).
CREATE TABLE stock_movement_lot (
  company_id  uuid NOT NULL,
  movement_id uuid NOT NULL,
  lot_id      uuid NOT NULL,
  quantity    numeric(18,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (company_id, movement_id, lot_id),
  FOREIGN KEY (company_id, movement_id) REFERENCES stock_movement (company_id, id),
  FOREIGN KEY (company_id, lot_id) REFERENCES stock_lot (company_id, id)
);

-- Lot et date limite saisis à l'entrée : facture fournisseur et bon d'entrée.
ALTER TABLE purchase_document_line ADD COLUMN lot_number text CHECK (length(lot_number) BETWEEN 1 AND 60), ADD COLUMN expiry_date date;
ALTER TABLE stock_document_line ADD COLUMN lot_number text CHECK (length(lot_number) BETWEEN 1 AND 60), ADD COLUMN expiry_date date;

ALTER TABLE stock_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_lot FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_lot_tenant ON stock_lot FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON stock_lot TO kora_app;
ALTER TABLE stock_movement_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement_lot FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movement_lot_tenant ON stock_movement_lot FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON stock_movement_lot TO kora_app;
-- La console vérifie si la fonctionnalité a déjà servi avant de la désactiver.
GRANT SELECT ON stock_lot TO kora_platform;
CREATE POLICY stock_lot_platform ON stock_lot FOR SELECT TO kora_platform USING (true);
