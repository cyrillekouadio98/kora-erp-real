-- =====================================================================
-- Kora ERP — Migration 0022 : multi-sites (magasins, succursales)
-- Une entreprise peut avoir plusieurs sites sur la même base. Chaque site regroupe ses entrepôts,
-- ses caisses et comptes, ses employés ; ventes, achats, documents de stock et écritures portent
-- leur site. Les clients, fournisseurs, articles et la comptabilité restent communs à l'entreprise.
-- Un utilisateur peut être limité à certains sites.
-- =====================================================================

CREATE TABLE site (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9._-]{1,20}$'),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  address     text,
  city        text,
  phone       text,
  is_default  boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, code),
  CONSTRAINT site_default_active_chk CHECK (NOT is_default OR archived_at IS NULL)
);
CREATE UNIQUE INDEX site_default_uq ON site (company_id) WHERE is_default;
CREATE TRIGGER site_touch BEFORE UPDATE ON site FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TABLE site ENABLE ROW LEVEL SECURITY;
ALTER TABLE site FORCE ROW LEVEL SECURITY;
CREATE POLICY site_tenant ON site FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON site TO kora_app;

-- Chaque entreprise existante reçoit un site principal, auquel tout ce qui existe est rattaché.
INSERT INTO site (company_id, code, name, city, is_default) SELECT id, 'S01', 'Site principal', city, true FROM company;

-- Utilisateur limité à certains sites (NULL : tous les sites).
ALTER TABLE company_membership ADD COLUMN site_ids uuid[];
-- Site choisi dans la session (NULL : tous les sites autorisés).
ALTER TABLE user_session ADD COLUMN active_site_id uuid;

-- Rattachement au site. Les verrous des documents validés et des écritures sont suspendus le temps du rattachement.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouse','treasury_account','employee','sales_document','purchase_document','stock_document','journal_entry']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN site_id uuid', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id)', t, t || '_site_fk');
    EXECUTE format('CREATE INDEX %I ON %I (company_id, site_id)', t || '_site_idx', t);
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', t);
    IF t = 'journal_entry' THEN
      -- Écritures de l'entreprise (paie, clôture, OD) : sans site.
      UPDATE journal_entry e SET site_id = s.id FROM site s WHERE s.company_id = e.company_id AND s.is_default
        AND e.source_type IN ('sales_document','purchase_document','treasury_movement','treasury_opening','stock_opening','reversal');
    ELSE
      EXECUTE format('UPDATE %I x SET site_id = s.id FROM site s WHERE s.company_id = x.company_id AND s.is_default', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN site_id SET NOT NULL', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', t);
  END LOOP;
END $$;

CREATE FUNCTION default_site_id(p_company uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM site WHERE company_id = p_company AND is_default
$$;
GRANT EXECUTE ON FUNCTION default_site_id(uuid) TO kora_app;

-- Site par défaut à la création, quand l'application ne l'indique pas.
CREATE FUNCTION assign_site() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.site_id IS NULL THEN
    IF TG_TABLE_NAME IN ('sales_document', 'purchase_document', 'stock_document') THEN
      SELECT site_id INTO NEW.site_id FROM warehouse WHERE company_id = NEW.company_id AND id = NEW.warehouse_id;
    END IF;
    NEW.site_id := coalesce(NEW.site_id, default_site_id(NEW.company_id));
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouse','treasury_account','employee','sales_document','purchase_document','stock_document']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION assign_site()', t || '_site', t);
  END LOOP;
END $$;

-- Écriture : site de l'opération d'origine (facture, mouvement de caisse, stock), sans site pour la paie et les OD.
CREATE FUNCTION journal_entry_site() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.site_id IS NOT NULL OR NEW.source_id IS NULL AND NEW.reversal_of IS NULL THEN RETURN NEW; END IF;
  NEW.site_id := CASE
    WHEN NEW.reversal_of IS NOT NULL THEN (SELECT site_id FROM journal_entry WHERE company_id = NEW.company_id AND id = NEW.reversal_of)
    WHEN NEW.source_type = 'sales_document' THEN (SELECT site_id FROM sales_document WHERE company_id = NEW.company_id AND id = NEW.source_id)
    WHEN NEW.source_type = 'purchase_document' THEN (SELECT site_id FROM purchase_document WHERE company_id = NEW.company_id AND id = NEW.source_id)
    WHEN NEW.source_type = 'treasury_movement' THEN (SELECT a.site_id FROM treasury_movement m JOIN treasury_account a ON a.company_id = m.company_id AND a.id = m.account_id
                                                     WHERE m.company_id = NEW.company_id AND m.id = NEW.source_id)
    WHEN NEW.source_type = 'treasury_opening' THEN (SELECT site_id FROM treasury_account WHERE company_id = NEW.company_id AND id = NEW.source_id)
    WHEN NEW.source_type = 'stock_opening' THEN (SELECT w.site_id FROM stock_movement m JOIN warehouse w ON w.company_id = m.company_id AND w.id = m.warehouse_id
                                                 WHERE m.company_id = NEW.company_id AND m.id = NEW.source_id)
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_site BEFORE INSERT ON journal_entry FOR EACH ROW EXECUTE FUNCTION journal_entry_site();
