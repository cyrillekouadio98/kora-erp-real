-- =====================================================================
-- Kora ERP — Migration 0017 : gestion des stocks complète
-- Entrepôts (dépôts, magasins), quantités par entrepôt, bons de stock (entrée, sortie,
-- transfert, inventaire) et entrepôt choisi sur les ventes et les achats.
-- La valorisation reste au CMUP par article, toutes entrepôts confondus : un transfert
-- déplace des quantités sans changer la valeur du stock.
-- =====================================================================

CREATE TABLE warehouse (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9-]{1,12}$'),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  address     text,
  is_default  boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, code),
  CONSTRAINT warehouse_default_active_chk CHECK (NOT is_default OR archived_at IS NULL)
);
CREATE UNIQUE INDEX warehouse_default_uq ON warehouse (company_id) WHERE is_default;
CREATE TRIGGER warehouse_touch BEFORE UPDATE ON warehouse FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Chaque entreprise existante reçoit son dépôt principal (les nouvelles le reçoivent à la première opération).
INSERT INTO warehouse (company_id, code, name, is_default) SELECT id, 'DP', 'Dépôt principal', true FROM company;

-- Quantité de chaque article dans chaque entrepôt ; la somme est égale à product.stock_qty.
CREATE TABLE stock_level (
  company_id   uuid NOT NULL,
  product_id   uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  quantity     numeric(18,3) NOT NULL DEFAULT 0 CONSTRAINT stock_level_positive_chk CHECK (quantity >= 0),
  PRIMARY KEY (company_id, product_id, warehouse_id),
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouse (company_id, id)
);
INSERT INTO stock_level (company_id, product_id, warehouse_id, quantity)
  SELECT p.company_id, p.id, w.id, p.stock_qty FROM product p JOIN warehouse w ON w.company_id = p.company_id AND w.is_default WHERE p.stock_qty > 0;

-- Bons de stock : brouillon (modifiable, supprimable) → validé (mouvements inscrits, numéro attribué, intangible).
CREATE TABLE stock_document (
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  type                text NOT NULL CHECK (type IN ('receipt','issue','transfer','inventory')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','done')),
  number              text,
  date                date NOT NULL DEFAULT current_date,
  warehouse_id        uuid NOT NULL,                 -- entrepôt concerné (départ d'un transfert)
  dest_warehouse_id   uuid,                          -- transfert : entrepôt d'arrivée
  reason              text NOT NULL,                 -- motif de l'entrée ou de la sortie
  contact_id          uuid,                          -- fournisseur (achat comptant) ou bénéficiaire
  treasury_account_id uuid,                          -- achat comptant : caisse, banque ou mobile money payé
  treasury_movement_id uuid,
  reference           text,
  notes               text,
  total_value         numeric(18,2) NOT NULL DEFAULT 0,
  validated_at        timestamptz,
  validated_by        uuid REFERENCES user_account(id),
  created_by          uuid REFERENCES user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouse (company_id, id),
  FOREIGN KEY (company_id, dest_warehouse_id) REFERENCES warehouse (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  FOREIGN KEY (company_id, treasury_account_id) REFERENCES treasury_account (company_id, id),
  CONSTRAINT stock_document_number_chk CHECK ((status = 'done') = (number IS NOT NULL)),
  CONSTRAINT stock_document_transfer_chk CHECK ((type = 'transfer') = (dest_warehouse_id IS NOT NULL) AND dest_warehouse_id IS DISTINCT FROM warehouse_id),
  CONSTRAINT stock_document_reason_chk CHECK (
       (type = 'receipt'   AND reason IN ('cash_purchase','production','return','gift','found','other'))
    OR (type = 'issue'     AND reason IN ('consumption','loss','theft','expired','gift','sample','other'))
    OR (type = 'transfer'  AND reason = 'transfer')
    OR (type = 'inventory' AND reason = 'inventory')),
  CONSTRAINT stock_document_cash_chk CHECK ((reason = 'cash_purchase') = (treasury_account_id IS NOT NULL))
);
CREATE INDEX stock_document_list_idx ON stock_document (company_id, type, date DESC);
CREATE TRIGGER stock_document_touch BEFORE UPDATE ON stock_document FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE stock_document_line (
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  position    integer NOT NULL,
  product_id  uuid NOT NULL,
  quantity    numeric(18,3) CHECK (quantity >= 0),   -- inventaire : quantité comptée (vide = pas encore compté)
  expected    numeric(18,3),                         -- inventaire : stock théorique, figé à la validation
  unit_cost   numeric(18,4) CHECK (unit_cost >= 0),  -- entrée : coût unitaire ; sinon CMUP appliqué, figé à la validation
  value       numeric(18,2),                         -- valeur du mouvement, figée à la validation
  note        text,
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, document_id, product_id),
  FOREIGN KEY (company_id, document_id) REFERENCES stock_document (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id)
);

-- Mouvements : entrepôt, quantité dans l'entrepôt après le mouvement, bon d'origine.
ALTER TABLE stock_movement DISABLE TRIGGER stock_movement_lock;
ALTER TABLE stock_movement
  ADD COLUMN warehouse_id uuid,
  ADD COLUMN wh_qty_after numeric(18,3),
  ADD COLUMN document_id  uuid,
  DROP CONSTRAINT stock_movement_reason_check,
  ADD CONSTRAINT stock_movement_reason_chk CHECK (reason IN ('opening','purchase','sale','sale_return','adjustment','receipt','issue','transfer'));
UPDATE stock_movement m SET warehouse_id = w.id, wh_qty_after = m.qty_after FROM warehouse w WHERE w.company_id = m.company_id AND w.is_default;
ALTER TABLE stock_movement
  ALTER COLUMN warehouse_id SET NOT NULL,
  ALTER COLUMN wh_qty_after SET NOT NULL,
  ADD CONSTRAINT stock_movement_wh_qty_chk CHECK (wh_qty_after >= 0),
  ADD CONSTRAINT stock_movement_warehouse_fk FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouse (company_id, id),
  ADD CONSTRAINT stock_movement_document_fk FOREIGN KEY (company_id, document_id) REFERENCES stock_document (company_id, id);
ALTER TABLE stock_movement ENABLE TRIGGER stock_movement_lock;
CREATE INDEX stock_movement_date_idx ON stock_movement (company_id, date, created_at);

-- Entrepôt de départ (ventes) ou d'arrivée (achats) ; vide = entrepôt par défaut.
ALTER TABLE sales_document ADD COLUMN warehouse_id uuid,
  ADD CONSTRAINT sales_document_warehouse_fk FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouse (company_id, id);
ALTER TABLE purchase_document ADD COLUMN warehouse_id uuid,
  ADD CONSTRAINT purchase_document_warehouse_fk FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouse (company_id, id);

-- Achat comptant de marchandises payé depuis la trésorerie (D 601 / C caisse ou banque)
ALTER TABLE treasury_movement DROP CONSTRAINT treasury_movement_source_type_chk;
ALTER TABLE treasury_movement ADD CONSTRAINT treasury_movement_source_type_chk
  CHECK (source_type IN ('sales_payment','purchase_payment','sales_refund','payroll','expense','income','transfer','cash_count','stock_purchase','reversal'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouse','stock_level','stock_document','stock_document_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON warehouse, stock_level TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_document, stock_document_line TO kora_app;

-- Nouveau module de droits « Stocks » : repris des droits « Articles » de chaque rôle standard
CREATE OR REPLACE FUNCTION pg_temp.grant_to_role(role_key text, perms text[]) RETURNS void LANGUAGE sql AS $$
  UPDATE role SET permissions = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(permissions || perms) p)
   WHERE is_system AND key = role_key;
$$;
SELECT pg_temp.grant_to_role('owner', ARRAY['stock.read','stock.create','stock.update','stock.validate','stock.cancel','stock.export','stock.admin']);
SELECT pg_temp.grant_to_role('director', ARRAY['stock.read','stock.export']);
SELECT pg_temp.grant_to_role('accountant', ARRAY['stock.read','stock.create','stock.update','stock.validate','stock.export']);
SELECT pg_temp.grant_to_role('finance_manager', ARRAY['stock.read','stock.export']);
SELECT pg_temp.grant_to_role('cashier', ARRAY['stock.read']);
SELECT pg_temp.grant_to_role('sales_rep', ARRAY['stock.read']);
SELECT pg_temp.grant_to_role('auditor', ARRAY['stock.read','stock.export']);
INSERT INTO role (company_id, key, name, description, is_system, permissions)
  SELECT id, 'storekeeper', 'Magasinier', 'Réceptions, sorties, transferts et inventaires',  true,
    ARRAY['contacts.read','products.read','purchases.read','sales.read','stock.create','stock.export','stock.read','stock.update','stock.validate']
  FROM company ON CONFLICT (company_id, key) DO NOTHING;
