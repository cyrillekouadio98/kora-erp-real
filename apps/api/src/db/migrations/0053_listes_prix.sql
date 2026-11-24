-- =====================================================================
-- Kora ERP — Migration 0053 : listes de prix (fonctionnalité « price_lists », V1.2)
-- Une liste (grossiste, demi-gros…) donne un prix par article, avec des paliers de quantité,
-- et peut appliquer une remise générale aux articles qu'elle ne cite pas. Un client reçoit
-- au plus une liste ; sans liste, le prix de l'article s'applique comme avant.
-- =====================================================================
CREATE TABLE price_list (
  company_id   uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct < 100),
  notes        text,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, name)
);
CREATE TABLE price_list_item (
  company_id   uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  list_id      uuid NOT NULL,
  product_id   uuid NOT NULL,
  unit_id      uuid,                                   -- autre unité de l'article (fonctionnalité units) ; vide : unité de l'article
  min_quantity numeric(18,3) NOT NULL DEFAULT 1 CHECK (min_quantity > 0),
  price        numeric(18,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (company_id, id),
  UNIQUE NULLS NOT DISTINCT (company_id, list_id, product_id, unit_id, min_quantity),
  FOREIGN KEY (company_id, list_id) REFERENCES price_list (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES product_unit (company_id, id)
);
ALTER TABLE contact ADD COLUMN price_list_id uuid,
  ADD CONSTRAINT contact_price_list_fk FOREIGN KEY (company_id, price_list_id) REFERENCES price_list (company_id, id);

ALTER TABLE price_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list FORCE ROW LEVEL SECURITY;
CREATE POLICY price_list_tenant ON price_list FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON price_list TO kora_app;
ALTER TABLE price_list_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_item FORCE ROW LEVEL SECURITY;
CREATE POLICY price_list_item_tenant ON price_list_item FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON price_list_item TO kora_app;
GRANT SELECT ON price_list TO kora_platform;
CREATE POLICY price_list_platform ON price_list FOR SELECT TO kora_platform USING (true);
