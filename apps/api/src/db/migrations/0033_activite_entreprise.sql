-- =====================================================================
-- Kora ERP — Migration 0033 : activité de l'entreprise
-- Commerce (achat-revente de marchandises), services (prestations) ou les deux.
-- Le module Articles s'y adapte : type proposé par défaut, stock, prix d'achat, libellés.
-- Les entreprises existantes gardent tout (« les deux »).
-- =====================================================================

ALTER TABLE company ADD COLUMN activity text NOT NULL DEFAULT 'mixed' CHECK (activity IN ('trade','services','mixed'));
