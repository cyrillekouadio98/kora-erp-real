-- Fiche employé : catégorie professionnelle, net à payer souhaité et sursalaire.
-- Le bouton « Calculer la fiche » part du net souhaité : salaire de base = salaire catégoriel de la
-- catégorie (grille paramétrable de l'entreprise), le sursalaire complète jusqu'au net demandé.
ALTER TABLE employee
  ADD COLUMN category     text CHECK (category IS NULL OR length(trim(category)) BETWEEN 1 AND 20),
  ADD COLUMN target_net   numeric(18,2) CHECK (target_net IS NULL OR target_net >= 0),
  ADD COLUMN extra_salary numeric(18,2) NOT NULL DEFAULT 0 CHECK (extra_salary >= 0);
