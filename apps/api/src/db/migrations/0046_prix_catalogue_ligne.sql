-- Prix catalogue de l'article au moment de la vente : quand le prix facturé est plus bas,
-- l'écart est présenté comme une remise sur la facture.
ALTER TABLE sales_document_line ADD COLUMN IF NOT EXISTS list_price numeric(18,2) CHECK (list_price IS NULL OR list_price >= 0);
ALTER TABLE purchase_document_line ADD COLUMN IF NOT EXISTS list_price numeric(18,2) CHECK (list_price IS NULL OR list_price >= 0);
