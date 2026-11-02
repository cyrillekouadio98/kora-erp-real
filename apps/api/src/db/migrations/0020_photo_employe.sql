-- =====================================================================
-- Kora ERP — Migration 0020 : photo des employés
-- Une photo par employé, réduite côté navigateur (vignette carrée). Rangée à part pour que
-- la liste des employés ne transporte pas les images : elles sont servies une à une.
-- =====================================================================

CREATE TABLE employee_photo (
  company_id  uuid NOT NULL,
  employee_id uuid NOT NULL,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data        bytea NOT NULL CHECK (octet_length(data) <= 300000),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, employee_id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id) ON DELETE CASCADE
);
ALTER TABLE employee_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_photo_tenant ON employee_photo FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_photo TO kora_app;
