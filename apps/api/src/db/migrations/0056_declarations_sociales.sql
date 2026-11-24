-- =====================================================================
-- Kora ERP — Migration 0056 : déclarations sociales et fiscales (fonctionnalité « social_declarations », V1.3)
-- États CNPS, ITS et DISA calculés à partir des bulletins validés ; seul le numéro d'employeur CNPS
-- de l'entreprise est ajouté (vide par défaut).
-- =====================================================================
ALTER TABLE company ADD COLUMN cnps_employer_number text CHECK (length(cnps_employer_number) <= 30);
