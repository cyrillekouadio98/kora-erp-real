-- Suppression d'un article jamais utilisé (aucune ligne de vente, d'achat ni mouvement de stock) :
-- l'article et ses niveaux de stock vides s'effacent. Un article utilisé s'archive.
GRANT DELETE ON product, stock_level TO kora_app;
