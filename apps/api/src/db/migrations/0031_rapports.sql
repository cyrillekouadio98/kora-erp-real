-- =====================================================================
-- N'Ora ERP — Migration 0031 : module Rapports
-- Permissions reports.read et reports.export ajoutées aux rôles standard existants
-- qui pilotent ou contrôlent (les nouvelles entreprises les reçoivent à leur création).
-- =====================================================================

UPDATE role
SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(permissions || ARRAY['reports.read', 'reports.export']) AS p ORDER BY p),
    updated_at = now()
WHERE key IN ('owner', 'director', 'accountant', 'finance_manager', 'auditor');
