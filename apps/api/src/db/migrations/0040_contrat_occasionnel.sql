-- Contrat « occasionnel » (chargeurs-déchargeurs, main-d'œuvre ponctuelle) : comme le stage, sans charges
-- sociales ni fiscales ni congés payés (règles portées par le calcul de paie et le module congés).
ALTER TABLE employee DROP CONSTRAINT IF EXISTS employee_contract_type_check;
ALTER TABLE employee ADD CONSTRAINT employee_contract_type_check
  CHECK (contract_type IN ('cdi','cdd','stage','journalier','occasionnel'));
