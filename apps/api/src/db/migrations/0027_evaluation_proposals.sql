-- Évaluations : proposition de prime et d'augmentation par l'évaluateur, sans voir les salaires.
-- La décision (montants réels) reste à qui voit les salaires.
ALTER TABLE evaluation
  ADD COLUMN proposed_bonus         numeric(18,2) CHECK (proposed_bonus > 0),
  ADD COLUMN proposed_raise_percent numeric(4,1)  CHECK (proposed_raise_percent > 0 AND proposed_raise_percent <= 100);
