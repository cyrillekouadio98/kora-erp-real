-- Rattrapage des documents déjà enregistrés : prix catalogue actuel de l'article, uniquement
-- quand il est supérieur au prix facturé (vente à prix baissé). Seule la colonne d'affichage
-- list_price est renseignée : prix, remises, totaux et numéros des documents restent inchangés.
-- Le verrou des documents validés est levé le temps de cette seule mise à jour.
ALTER TABLE sales_document_line DISABLE TRIGGER sales_line_lock;
UPDATE sales_document_line l SET list_price = p.sale_price
  FROM product p
 WHERE p.company_id = l.company_id AND p.id = l.product_id
   AND l.list_price IS NULL AND p.sale_price > l.unit_price;
ALTER TABLE sales_document_line ENABLE TRIGGER sales_line_lock;
