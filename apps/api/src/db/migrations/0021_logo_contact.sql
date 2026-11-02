-- =====================================================================
-- Kora ERP — Migration 0021 : logo ou photo des clients et fournisseurs
-- Même principe que la photo des employés : vignette réduite par le navigateur,
-- rangée à part et servie une à une.
-- =====================================================================

CREATE TABLE contact_logo (
  company_id  uuid NOT NULL,
  contact_id  uuid NOT NULL,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data        bytea NOT NULL CHECK (octet_length(data) <= 300000),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, contact_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id) ON DELETE CASCADE
);
ALTER TABLE contact_logo ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_logo FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_logo_tenant ON contact_logo FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_logo TO kora_app;
