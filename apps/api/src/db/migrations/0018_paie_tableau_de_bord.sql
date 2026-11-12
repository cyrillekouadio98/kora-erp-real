-- Tableau de bord de la paie : notes partagées de l'équipe paie (onglets libres, cases à cocher).
-- Format : [{ "id": "...", "title": "Note", "body": "texte, une ligne « [ ] » ou « [x] » par case" }]
ALTER TABLE payroll_settings
  ADD COLUMN notes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notes) = 'array');
