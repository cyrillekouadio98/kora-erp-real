-- Préparation d'une entreprise par l'équipe de l'éditeur, avant sa remise au client.
-- La console crée l'entreprise (fiche, formule, sites, comptes de trésorerie, utilisateurs prévus)
-- sans en être membre ; à la remise, le propriétaire et les collaborateurs reçoivent leur invitation
-- et la console perd tout accès en écriture. Aucune donnée du client n'existe encore à ce stade.
CREATE TABLE company_setup (
  company_id     uuid PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
  owner_name     text,
  owner_email    text CHECK (owner_email = lower(owner_email)),
  -- Collaborateurs prévus : [{ name, email, roleKey, siteIds }]
  users          jsonb NOT NULL DEFAULT '[]',
  trial_days     integer CHECK (trial_days BETWEEN 0 AND 90),
  notes          text,
  prepared_by    uuid NOT NULL REFERENCES user_account(id),
  handed_over_at timestamptz,
  handed_over_by uuid REFERENCES user_account(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER company_setup_touch BEFORE UPDATE ON company_setup FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TABLE company_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_setup FORCE ROW LEVEL SECURITY;
-- Créée dans la même transaction que l'entreprise (rôle kora_app), suivie ensuite par la console.
GRANT SELECT, INSERT, UPDATE ON company_setup TO kora_app;
CREATE POLICY company_setup_app ON company_setup FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, UPDATE ON company_setup TO kora_platform;
CREATE POLICY company_setup_platform ON company_setup FOR ALL TO kora_platform USING (true) WITH CHECK (true);

-- Invitation du propriétaire : à son acceptation, l'adhésion devient propriétaire de l'entreprise.
ALTER TABLE invitation ADD COLUMN is_owner boolean NOT NULL DEFAULT false;
