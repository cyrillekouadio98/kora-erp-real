-- =====================================================================
-- Kora ERP — Migration 0004 : avoirs et relances clients
-- Un avoir annule tout ou partie d'une facture émise : il diminue son reste à payer.
-- Une facture entièrement couverte par des avoirs passe au statut « credited ».
-- =====================================================================

ALTER TABLE sales_document
  DROP CONSTRAINT sales_document_type_check,
  DROP CONSTRAINT sales_document_check1,
  ADD COLUMN credited_amount   numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN source_invoice_id uuid,
  ADD CONSTRAINT sales_document_type_chk CHECK (type IN ('quote','invoice','credit_note')),
  ADD CONSTRAINT sales_document_status_chk CHECK (
       (type = 'quote' AND status IN ('draft','sent','accepted','refused','invoiced'))
    OR (type = 'invoice' AND status IN ('draft','issued','partially_paid','paid','credited'))
    OR (type = 'credit_note' AND status IN ('draft','issued'))),
  ADD CONSTRAINT sales_document_credited_chk CHECK (credited_amount >= 0 AND credited_amount <= total_ttc),
  ADD CONSTRAINT sales_document_credit_source_chk CHECK ((type = 'credit_note') = (source_invoice_id IS NOT NULL)),
  ADD CONSTRAINT sales_document_source_invoice_fk FOREIGN KEY (company_id, source_invoice_id) REFERENCES sales_document (company_id, id);

-- Relances : chaque contact avec le client au sujet d'une facture impayée est tracé.
CREATE TABLE sales_reminder (
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('phone','whatsapp','sms','email','letter','visit')),
  note        text,
  promised_on date,                      -- date de paiement promise par le client
  created_by  uuid REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES sales_document (company_id, id)
);
CREATE INDEX sales_reminder_doc_idx ON sales_reminder (company_id, document_id, created_at DESC);

ALTER TABLE sales_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_reminder_tenant ON sales_reminder FOR ALL TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON sales_reminder TO kora_app;
