-- =====================================================================
-- Kora ERP — Migration 0036 : mouvements de trésorerie en brouillon, modifiables et supprimables
-- Les dépenses, recettes et virements saisis à la main se remettent en brouillon (ils sortent du
-- solde, leur écriture comptable est contre-passée à sa date), se modifient sur place, se revalident,
-- et un administrateur peut les supprimer. Les mouvements issus d'une facture, de la paie ou d'un
-- arrêté de caisse restent intangibles : ils se corrigent depuis leur document.
-- =====================================================================

ALTER TABLE treasury_movement ADD COLUMN status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','draft'));
CREATE INDEX treasury_movement_draft_idx ON treasury_movement (company_id, account_id) WHERE status = 'draft';

-- Un mouvement validé reste intangible, sauf trois cas : inscription de sa contre-passation, remise en
-- brouillon (seul le statut change), suppression d'une paire déjà contre-passée. Un brouillon se modifie et se supprime.
CREATE OR REPLACE FUNCTION treasury_movement_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' OR OLD.reversed_by IS NOT NULL OR OLD.reversal_of IS NOT NULL THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'mouvement de trésorerie : remettez-le en brouillon avant de le supprimer' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.reversed_by IS NULL AND NEW.reversed_by IS NOT NULL
     AND (to_jsonb(NEW) - 'reversed_by') = (to_jsonb(OLD) - 'reversed_by') THEN RETURN NEW; END IF;
  IF NEW.status = 'draft' AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'mouvement de trésorerie : modification interdite (remettez-le en brouillon)' USING ERRCODE = 'check_violation';
END $$;

GRANT DELETE ON treasury_movement TO kora_app;
