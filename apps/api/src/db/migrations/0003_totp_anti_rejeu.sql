-- =====================================================================
-- Kora ERP — Migration 0003 : codes de double authentification à usage unique
-- Dernier pas de temps TOTP (fenêtres de 30 s depuis l'époque Unix) accepté pour le compte :
-- un code déjà utilisé, ou plus ancien, est refusé (protection contre le rejeu).
-- =====================================================================

ALTER TABLE user_account ADD COLUMN totp_last_step integer;
