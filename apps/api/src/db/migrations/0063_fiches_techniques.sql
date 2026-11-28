-- =====================================================================
-- Kora ERP — Migration 0063 : fiches techniques (restaurant, V1.4, activable par entreprise)
-- Un plat vendu (ticket de caisse, commande à table ou facture) sort de stock ses ingrédients,
-- selon les quantités de sa fiche pour une portion. Les ingrédients sont des articles suivis
-- en stock ; un plat n'est pas lui-même l'ingrédient d'une autre fiche (pas d'imbrication).
-- =====================================================================
CREATE TABLE product_recipe (
  company_id    uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  position      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, product_id, ingredient_id),
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, ingredient_id) REFERENCES product (company_id, id),
  CHECK (product_id <> ingredient_id)
);
CREATE INDEX product_recipe_ingredient_idx ON product_recipe (company_id, ingredient_id);
ALTER TABLE product_recipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_recipe FORCE ROW LEVEL SECURITY;
CREATE POLICY product_recipe_tenant ON product_recipe FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON product_recipe TO kora_app;
