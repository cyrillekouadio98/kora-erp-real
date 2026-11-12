-- =====================================================================
-- Kora ERP — Migration 0002 : paiements reçus mais non affectés
-- Un paiement dont le montant ou la devise ne correspond pas à la facture, ou qui arrive
-- sur une facture déjà réglée ou annulée, est conservé (l'argent a bien été reçu) sous le
-- statut « unapplied », avec son motif, pour traitement par le gestionnaire de facturation.
-- Il n'est jamais compté comme encaissé et ne règle aucune facture.
-- =====================================================================

ALTER TABLE platform_payment DROP CONSTRAINT platform_payment_status_check;
ALTER TABLE platform_payment ADD CONSTRAINT platform_payment_status_check
  CHECK (status IN ('succeeded','unapplied','refunded'));

ALTER TABLE platform_payment ADD COLUMN unapplied_reason text;
ALTER TABLE platform_payment ADD CONSTRAINT platform_payment_unapplied_reason_check
  CHECK ((status = 'unapplied') = (unapplied_reason IS NOT NULL));

CREATE INDEX platform_payment_unapplied_idx ON platform_payment (received_at DESC) WHERE status = 'unapplied';
