-- =====================================================================
-- Kora ERP — Migration 0016 : bons de commande clients
-- Devis accepté → bon de commande client → facture, sans ressaisie : chaque document reprend
-- les lignes du précédent et garde le lien vers lui (suivi commercial et comptable).
-- Le bon de commande n'a aucun effet en stock ni en comptabilité : seule la facture en a.
-- =====================================================================

ALTER TABLE sales_document
  DROP CONSTRAINT sales_document_type_chk,
  DROP CONSTRAINT sales_document_status_chk,
  ADD COLUMN source_order_id uuid,
  ADD COLUMN delivery_date   date,                 -- commande : livraison prévue
  ADD COLUMN customer_ref    text CHECK (customer_ref IS NULL OR length(customer_ref) BETWEEN 1 AND 60), -- n° de commande du client
  ADD CONSTRAINT sales_document_type_chk CHECK (type IN ('quote','order','invoice','credit_note')),
  ADD CONSTRAINT sales_document_status_chk CHECK (
       (type = 'quote' AND status IN ('draft','sent','accepted','refused','ordered','invoiced'))
    OR (type = 'order' AND status IN ('draft','confirmed','invoiced','cancelled'))
    OR (type = 'invoice' AND status IN ('draft','issued','partially_paid','paid','credited'))
    OR (type = 'credit_note' AND status IN ('draft','issued'))),
  ADD CONSTRAINT sales_document_order_source_chk CHECK (source_order_id IS NULL OR type = 'invoice'),
  ADD CONSTRAINT sales_document_source_order_fk FOREIGN KEY (company_id, source_order_id) REFERENCES sales_document (company_id, id);

-- Pas de doublon : un devis n'a qu'une commande en cours, une commande n'a qu'une facture.
CREATE UNIQUE INDEX sales_order_per_quote_uq ON sales_document (company_id, source_quote_id) WHERE type = 'order' AND status <> 'cancelled';
CREATE UNIQUE INDEX sales_invoice_per_order_uq ON sales_document (company_id, source_order_id) WHERE type = 'invoice';
