-- =====================================================================
-- Kora ERP — Migration 0019 : remise en brouillon après validation
-- Une facture client ou fournisseur sans règlement, et une paie dont aucun salaire n'est payé,
-- peuvent repasser en brouillon pour être corrigées. L'écriture comptable est contre-passée
-- (jamais supprimée), le stock est réintégré, et le document garde son numéro : la
-- numérotation reste continue et il le reprend à la nouvelle validation.
-- =====================================================================

-- Un brouillon peut porter le numéro reçu à une validation précédente ; un document validé en a toujours un.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
            WHERE conrelid IN ('sales_document'::regclass, 'purchase_document'::regclass) AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%number IS NULL%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
ALTER TABLE sales_document ADD CONSTRAINT sales_document_number_chk CHECK (status = 'draft' OR number IS NOT NULL);
ALTER TABLE purchase_document ADD CONSTRAINT purchase_document_number_chk CHECK (status = 'draft' OR number IS NOT NULL);

-- Une opération n'a qu'une écriture en vigueur : celle d'une validation annulée reste, contre-passée.
DROP INDEX journal_entry_source_uq;
CREATE UNIQUE INDEX journal_entry_source_uq ON journal_entry (company_id, source_type, source_id) WHERE source_id IS NOT NULL AND reversed_by IS NULL;

-- Mouvement de stock qui annule celui d'une facture remise en brouillon.
ALTER TABLE stock_movement
  DROP CONSTRAINT stock_movement_reason_chk,
  ADD CONSTRAINT stock_movement_reason_chk CHECK (reason IN ('opening','purchase','sale','sale_return','adjustment','receipt','issue','transfer','cancellation'));

-- Paie validée : seule la remise en brouillon est permise, et seulement si aucun salaire n'est payé.
CREATE OR REPLACE FUNCTION payroll_run_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'validated' THEN RAISE EXCEPTION 'paie validée : suppression interdite' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'validated' THEN
    IF NEW.status = 'draft' AND (NEW.period, NEW.params) IS NOT DISTINCT FROM (OLD.period, OLD.params)
       AND NOT EXISTS (SELECT 1 FROM payslip WHERE company_id = OLD.company_id AND run_id = OLD.id AND paid_at IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'paie validée : modification interdite' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
