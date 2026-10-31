-- Plan comptable : tous les numéros de compte sur 6 chiffres, complétés à droite par des zéros
-- (411 → 411000, 4431 → 443100, 5711 → 571100). La hiérarchie se lit en retirant les zéros de fin :
-- 571000 regroupe 571100, 571200… Aucun numéro n'entre en collision (vérifié avant la renumérotation).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_account GROUP BY company_id, rpad(code, 6, '0') HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'deux comptes deviendraient identiques sur 6 chiffres : renumérotation impossible';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_account WHERE length(code) > 6) THEN
    RAISE EXCEPTION 'un compte a plus de 6 chiffres : renumérotation impossible';
  END IF;
END $$;

-- Renumérotation technique : les montants, dates et numéros d'écritures ne changent pas,
-- seul le numéro de compte des lignes (y compris validées) est complété.
ALTER TABLE journal_line DROP CONSTRAINT journal_line_company_id_account_code_fkey;
ALTER TABLE treasury_account DROP CONSTRAINT treasury_account_ledger_fk;
ALTER TABLE journal_line DISABLE TRIGGER journal_line_lock;

UPDATE ledger_account SET code = rpad(code, 6, '0') WHERE length(code) < 6;
UPDATE journal_line SET account_code = rpad(account_code, 6, '0') WHERE length(account_code) < 6;
UPDATE treasury_account SET ledger_code = rpad(ledger_code, 6, '0') WHERE length(ledger_code) < 6;

ALTER TABLE journal_line ENABLE TRIGGER journal_line_lock;
ALTER TABLE journal_line ADD CONSTRAINT journal_line_company_id_account_code_fkey
  FOREIGN KEY (company_id, account_code) REFERENCES ledger_account (company_id, code);
ALTER TABLE treasury_account ADD CONSTRAINT treasury_account_ledger_fk
  FOREIGN KEY (company_id, ledger_code) REFERENCES ledger_account (company_id, code);
ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_code_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_code_check CHECK (code ~ '^[1-9][0-9]{5}$');

-- Plan des nouvelles entreprises, directement sur 6 chiffres
CREATE OR REPLACE FUNCTION seed_accounting(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system)
  SELECT p_company, rpad(code, 6, '0'), name, true FROM (VALUES
    ('101','Capital social'), ('104','Compte de l''exploitant'), ('111','Réserve légale'), ('118','Autres réserves'),
    ('121','Report à nouveau créditeur'), ('129','Report à nouveau débiteur'), ('131','Résultat net : bénéfice'), ('139','Résultat net : perte'),
    ('162','Emprunts et dettes auprès des établissements de crédit'), ('165','Dépôts et cautionnements reçus'),
    ('213','Logiciels et sites internet'), ('231','Bâtiments'), ('241','Matériel et outillage industriel et commercial'), ('244','Matériel et mobilier de bureau'),
    ('245','Matériel de transport'), ('275','Dépôts et cautionnements versés'), ('2813','Amortissements des logiciels'), ('2831','Amortissements des bâtiments'),
    ('2841','Amortissements du matériel et outillage'), ('2844','Amortissements du matériel et mobilier de bureau'), ('2845','Amortissements du matériel de transport'),
    ('311','Marchandises'), ('321','Matières premières'), ('331','Matières et fournitures consommables'), ('361','Produits finis'),
    ('401','Fournisseurs'), ('408','Fournisseurs, factures non parvenues'), ('409','Fournisseurs débiteurs, avances et acomptes versés'),
    ('411','Clients'), ('418','Clients, produits à recevoir'), ('419','Clients créditeurs, avances et acomptes reçus'),
    ('421','Personnel, avances et acomptes'), ('422','Personnel, rémunérations dues'), ('431','Sécurité sociale (CNPS)'),
    ('441','État, impôt sur les bénéfices'), ('4431','État, TVA facturée sur ventes'), ('4441','État, TVA due'), ('4449','État, crédit de TVA à reporter'),
    ('4452','État, TVA récupérable sur achats'), ('4454','État, TVA récupérable sur services extérieurs'), ('447','État, impôts retenus à la source'),
    ('462','Associés, comptes courants'), ('471','Comptes d''attente'),
    ('521','Banques'), ('552','Monnaie électronique — téléphone portable'), ('571','Caisse'), ('585','Virements de fonds'),
    ('601','Achats de marchandises'), ('602','Achats de matières premières'), ('6031','Variations des stocks de marchandises'),
    ('604','Achats stockés de matières et fournitures consommables'), ('605','Autres achats'), ('6051','Fournitures non stockables — eau'),
    ('6052','Fournitures non stockables — électricité'), ('6053','Fournitures non stockables — autres énergies'), ('6055','Fournitures de bureau non stockables'),
    ('6056','Achats de petit matériel et outillage'), ('612','Transports sur ventes'), ('614','Transports du personnel'), ('618','Autres frais de transport'),
    ('622','Locations et charges locatives'), ('6222','Locations de bâtiments'), ('624','Entretien, réparations et maintenance'), ('625','Primes d''assurance'),
    ('627','Publicité, publications, relations publiques'), ('628','Frais de télécommunications'), ('631','Frais bancaires'),
    ('632','Rémunérations d''intermédiaires et de conseils'), ('641','Impôts et taxes directs'), ('645','Impôts et taxes indirects'),
    ('646','Droits d''enregistrement'), ('658','Charges diverses'), ('661','Rémunérations directes versées au personnel national'), ('664','Charges sociales'),
    ('671','Intérêts des emprunts'), ('681','Dotations aux amortissements d''exploitation'),
    ('701','Ventes de marchandises'), ('702','Ventes de produits finis'), ('706','Services vendus'), ('707','Produits accessoires'), ('758','Produits divers'),
    ('891','Impôts sur les bénéfices de l''exercice')
  ) AS chart(code, name)
  ON CONFLICT DO NOTHING;
  INSERT INTO journal (company_id, code, name)
  SELECT p_company, code, name FROM (VALUES ('VT','Ventes'), ('AC','Achats'), ('TR','Trésorerie'), ('OD','Opérations diverses'), ('AN','À-nouveaux')) AS j(code, name)
  ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION seed_accounting_extra(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system) VALUES (p_company, '438000', 'Autres organismes sociaux (CMU)', true) ON CONFLICT DO NOTHING;
$$;
