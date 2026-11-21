-- =====================================================================
-- Kora ERP — Migration 0048 : contrepartie des soldes d'ouverture des comptes de trésorerie
-- Le solde d'ouverture d'une caisse ou d'une banque n'est plus passé d'office au compte d'attente 471 :
-- l'utilisateur choisit l'origine des fonds (121 report à nouveau par défaut, 101, 462, 401, 162 ou 471).
-- Les comptes existants gardent 471000, pour que les écarts futurs suivent les écritures déjà passées ;
-- le 471 existant se reclasse depuis la comptabilité.
-- =====================================================================
ALTER TABLE treasury_account ADD COLUMN opening_counterpart text NOT NULL DEFAULT '121000'
  CHECK (opening_counterpart IN ('121000', '101000', '462000', '401000', '162000', '471000'));
UPDATE treasury_account SET opening_counterpart = '471000';
