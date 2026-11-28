-- =====================================================================
-- Kora ERP — Migration 0061 : restaurants, plan de salle et commandes à table (V1.4, activable par entreprise)
-- Chaque site a ses salles (« Salle », « Terrasse ») et leurs tables, placées sur une grille.
-- Une table occupée porte une commande ouverte, complétée au fil du repas par les serveurs ;
-- l'encaissement la transforme en ticket de caisse ordinaire (stock, comptabilité, trésorerie
-- suivent le chemin d'une vente au comptoir). Une seule commande ouverte par table.
-- =====================================================================
CREATE TABLE dining_area (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  position    integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id)
);
CREATE UNIQUE INDEX dining_area_name_uq ON dining_area (company_id, site_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE dining_table (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL,
  area_id     uuid NOT NULL,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  seats       integer NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 50),
  shape       text NOT NULL DEFAULT 'square' CHECK (shape IN ('square', 'round', 'long')),
  -- Case de la grille du plan (colonne, ligne), à partir de 0.
  x           integer NOT NULL DEFAULT 0 CHECK (x BETWEEN 0 AND 29),
  y           integer NOT NULL DEFAULT 0 CHECK (y BETWEEN 0 AND 29),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, area_id) REFERENCES dining_area (company_id, id)
);
CREATE UNIQUE INDEX dining_table_name_uq ON dining_table (company_id, site_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE table_order (
  company_id    uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL,
  table_id      uuid NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  guests        integer NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 200),
  note          text,
  opened_by     uuid NOT NULL REFERENCES user_account(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  ticket_id     uuid,
  closed_by     uuid REFERENCES user_account(id),
  closed_at     timestamptz,
  cancel_reason text,
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, table_id) REFERENCES dining_table (company_id, id),
  FOREIGN KEY (company_id, ticket_id) REFERENCES sales_document (company_id, id),
  CONSTRAINT table_order_paid_chk CHECK (status <> 'paid' OR ticket_id IS NOT NULL)
);
CREATE UNIQUE INDEX table_order_open_uq ON table_order (company_id, table_id) WHERE status = 'open';
CREATE INDEX table_order_site_idx ON table_order (company_id, site_id, opened_at DESC);

CREATE TABLE table_order_line (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL,
  order_id    uuid NOT NULL,
  product_id  uuid,
  description text NOT NULL CHECK (length(trim(description)) > 0),
  unit        text,
  quantity    numeric(18,3) NOT NULL CHECK (quantity > 0),
  unit_price  numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  vat_rate    numeric(5,2) NOT NULL,
  note        text,
  created_by  uuid NOT NULL REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, order_id) REFERENCES table_order (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, product_id) REFERENCES product (company_id, id)
);
CREATE INDEX table_order_line_order_idx ON table_order_line (company_id, order_id);

-- Sécurité : entreprise active, puis sites permis à l'utilisateur (comme les caisses).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dining_area','dining_table','table_order','table_order_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO kora_app USING (app_site_ids() IS NULL OR site_id = ANY (app_site_ids())) WITH CHECK (app_site_ids() IS NULL OR site_id = ANY (app_site_ids()))', t || '_site', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON dining_area, dining_table, table_order TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON table_order_line TO kora_app;
