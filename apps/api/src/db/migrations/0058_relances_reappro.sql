-- =====================================================================
-- Kora ERP — Migration 0058 : relances automatiques (« auto_reminders ») et réapprovisionnement (« restock »), V1.3
-- Les règles de relance de l'entreprise (étapes en jours après l'échéance, message de chaque étape) ;
-- chaque relance envoyée automatiquement garde son étape pour n'être jamais envoyée deux fois.
-- =====================================================================
CREATE TABLE dunning_settings (
  company_id   uuid PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT true,
  steps        jsonb NOT NULL,                -- [{ days, subject, message }]
  copy_to      text CHECK (length(copy_to) <= 254),
  last_run_on  date,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dunning_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY dunning_settings_tenant ON dunning_settings FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON dunning_settings TO kora_app;
GRANT SELECT ON dunning_settings TO kora_platform;
CREATE POLICY dunning_settings_platform ON dunning_settings FOR SELECT TO kora_platform USING (true);

ALTER TABLE sales_reminder ADD COLUMN auto_step integer CHECK (auto_step BETWEEN 1 AND 10);
