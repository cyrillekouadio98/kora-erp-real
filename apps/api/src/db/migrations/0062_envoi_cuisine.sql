-- =====================================================================
-- Kora ERP — Migration 0062 : envoi des commandes en cuisine (restaurant, V1.4)
-- Chaque article a son poste de préparation : cuisine, bar, ou aucun (servi tel quel).
-- Le serveur saisit la commande puis l'envoie : les articles à préparer forment un bon par poste,
-- affiché sur l'écran du poste et imprimable. Le poste le marque prêt, le serveur le marque servi.
-- Un article envoyé ne se retire plus sans l'accord du responsable de caisse.
-- =====================================================================
ALTER TABLE product ADD COLUMN prep_station text NOT NULL DEFAULT 'kitchen' CHECK (prep_station IN ('kitchen', 'bar', 'none'));

CREATE TABLE kitchen_ticket (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL,
  order_id    uuid NOT NULL,
  station     text NOT NULL CHECK (station IN ('kitchen', 'bar')),
  -- Numéro du bon dans la journée du site (affiché en cuisine : « Bon 12 »).
  number      integer NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'served', 'cancelled')),
  created_by  uuid NOT NULL REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  ready_at    timestamptz,
  ready_by    uuid REFERENCES user_account(id),
  served_at   timestamptz,
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, order_id) REFERENCES table_order (company_id, id) ON DELETE CASCADE
);
CREATE INDEX kitchen_ticket_board_idx ON kitchen_ticket (company_id, site_id, station, status, created_at);

ALTER TABLE table_order_line ADD COLUMN sent_at timestamptz;
ALTER TABLE table_order_line ADD COLUMN kitchen_ticket_id uuid;
ALTER TABLE table_order_line ADD CONSTRAINT table_order_line_ticket_fk FOREIGN KEY (company_id, kitchen_ticket_id) REFERENCES kitchen_ticket (company_id, id) ON DELETE SET NULL;

ALTER TABLE kitchen_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_ticket_tenant ON kitchen_ticket FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY kitchen_ticket_site ON kitchen_ticket AS RESTRICTIVE FOR ALL TO kora_app USING (app_site_ids() IS NULL OR site_id = ANY (app_site_ids())) WITH CHECK (app_site_ids() IS NULL OR site_id = ANY (app_site_ids()));
GRANT SELECT, INSERT, UPDATE ON kitchen_ticket TO kora_app;
