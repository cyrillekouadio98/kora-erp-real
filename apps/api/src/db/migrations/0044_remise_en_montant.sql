-- Remise en montant (FCFA, sur le total HT de la ligne), en plus ou à la place de la remise en %.
ALTER TABLE sales_document_line ADD COLUMN discount_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
ALTER TABLE purchase_document_line ADD COLUMN discount_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
