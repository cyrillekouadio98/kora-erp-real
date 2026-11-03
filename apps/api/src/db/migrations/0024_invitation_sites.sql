-- =====================================================================
-- Kora ERP — Migration 0024 : sites d'une invitation
-- L'invité reçoit à son arrivée la limite de sites choisie (NULL : tous les sites).
-- =====================================================================
ALTER TABLE invitation ADD COLUMN site_ids uuid[];
