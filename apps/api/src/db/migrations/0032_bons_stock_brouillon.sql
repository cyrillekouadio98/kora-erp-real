-- Un bon de stock validé peut être remis en brouillon pour être corrigé : il garde son numéro
-- (numérotation continue), comme les factures remises en brouillon.
ALTER TABLE stock_document DROP CONSTRAINT stock_document_number_chk;
ALTER TABLE stock_document ADD CONSTRAINT stock_document_number_chk CHECK (status = 'draft' OR number IS NOT NULL);
