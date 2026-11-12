-- =====================================================================
-- Kora ERP — Migration 0034 : point de vente (POS)
-- Supermarchés, boutiques, pharmacies : vente au comptoir rapide, scan des codes-barres,
-- encaissement immédiat (espèces avec rendu de monnaie, mobile money, carte), ticket de caisse.
-- Une caisse (terminal) appartient à un site, sort la marchandise d'un entrepôt et encaisse les
-- espèces sur un compte de caisse. Le caissier ouvre une session (fond de caisse), vend, puis la
-- clôture en comptant le tiroir : l'écart est inscrit en trésorerie.
-- Chaque ticket est une facture de vente soldée, rattachée à sa session : le stock, la comptabilité
-- et la trésorerie suivent exactement le même chemin qu'une facture.
-- =====================================================================

-- Code-barres (EAN-13, EAN-8, UPC, code interne) : lu par la douchette à la caisse.
ALTER TABLE product ADD COLUMN barcode text CHECK (barcode IS NULL OR barcode ~ '^[A-Za-z0-9._-]{1,40}$');
CREATE UNIQUE INDEX product_barcode_uq ON product (company_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE pos_register (
  company_id      uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL,
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  warehouse_id    uuid NOT NULL,
  cash_account_id uuid NOT NULL,
  -- Client des ventes au comptoir (« Client comptoir ») quand le caissier n'en choisit pas.
  customer_id     uuid NOT NULL,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, name),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouse (company_id, id),
  FOREIGN KEY (company_id, cash_account_id) REFERENCES treasury_account (company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES contact (company_id, id)
);
CREATE TRIGGER pos_register_touch BEFORE UPDATE ON pos_register FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE pos_session (
  company_id     uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL,
  register_id    uuid NOT NULL,
  number         text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opening_float  numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  opened_by      uuid NOT NULL REFERENCES user_account(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  -- Clôture : espèces attendues (fond + ventes en espèces), comptées, et écart inscrit en trésorerie.
  expected_cash  numeric(18,2),
  counted_cash   numeric(18,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  difference     numeric(18,2),
  closing_note   text,
  closed_by      uuid REFERENCES user_account(id),
  closed_at      timestamptz,
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, register_id) REFERENCES pos_register (company_id, id),
  CONSTRAINT pos_session_closed_chk CHECK (status = 'open' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL))
);
-- Une seule session ouverte par caisse.
CREATE UNIQUE INDEX pos_session_open_uq ON pos_session (company_id, register_id) WHERE status = 'open';
CREATE INDEX pos_session_register_idx ON pos_session (company_id, register_id, opened_at DESC);

-- Ticket de caisse = facture de vente soldée rattachée à la session.
ALTER TABLE sales_document ADD COLUMN pos_session_id uuid;
ALTER TABLE sales_document ADD CONSTRAINT sales_document_pos_session_fk FOREIGN KEY (company_id, pos_session_id) REFERENCES pos_session (company_id, id);
CREATE INDEX sales_document_pos_session_idx ON sales_document (company_id, pos_session_id) WHERE pos_session_id IS NOT NULL;
-- Rendu de monnaie remis au client (les espèces reçues moins le rendu sont encaissées).
ALTER TABLE sales_document ADD COLUMN cash_tendered numeric(18,2);

-- Sécurité : entreprise active, puis sites permis à l'utilisateur.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_register','pos_session']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO kora_app USING (app_site_ids() IS NULL OR site_id = ANY (app_site_ids())) WITH CHECK (app_site_ids() IS NULL OR site_id = ANY (app_site_ids()))', t || '_site', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON pos_register, pos_session TO kora_app;

-- Nouveau module « Point de vente » : droits ajoutés aux rôles standard existants.
CREATE OR REPLACE FUNCTION pg_temp.grant_to_role(role_key text, perms text[]) RETURNS void LANGUAGE sql AS $$
  UPDATE role SET permissions = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(permissions || perms) p), updated_at = now()
   WHERE is_system AND key = role_key;
$$;
SELECT pg_temp.grant_to_role('owner', ARRAY['pos.read','pos.create','pos.validate','pos.export','pos.admin']);
SELECT pg_temp.grant_to_role('director', ARRAY['pos.read','pos.validate','pos.export']);
SELECT pg_temp.grant_to_role('accountant', ARRAY['pos.read','pos.export']);
SELECT pg_temp.grant_to_role('finance_manager', ARRAY['pos.read','pos.validate','pos.export']);
SELECT pg_temp.grant_to_role('cashier', ARRAY['pos.read','pos.create']);
SELECT pg_temp.grant_to_role('sales_rep', ARRAY['pos.read','pos.create']);
SELECT pg_temp.grant_to_role('auditor', ARRAY['pos.read','pos.export']);
