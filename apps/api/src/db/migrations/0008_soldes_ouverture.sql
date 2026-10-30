-- =====================================================================
-- Kora ERP — Migration 0008 : solde d'ouverture des comptes de trésorerie en comptabilité
-- Le solde d'ouverture d'une caisse ou d'une banque est passé en à-nouveaux (journal AN),
-- en contrepartie du compte d'attente 471, que le comptable solde avec le bilan d'ouverture.
-- =====================================================================
ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_check;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_chk
  CHECK (source_type IN ('manual','sales_document','purchase_document','treasury_movement','treasury_opening','reversal'));
