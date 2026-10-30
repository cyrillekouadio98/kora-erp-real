-- =====================================================================
-- Kora ERP — Migration 0007 : comptabilité SYSCOHADA révisé
-- Plan comptable par entreprise, journaux, écritures en partie double.
-- Garanties tenues par la base :
--   * une écriture validée est équilibrée (débit = crédit), vérifié à la fin de la transaction ;
--   * une écriture validée ne se modifie ni ne se supprime (elle se contre-passe) ;
--   * aucune écriture ne peut être validée dans une période clôturée.
-- =====================================================================

CREATE TABLE ledger_account (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (code ~ '^[1-9][0-9]{1,9}$'),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  is_system   boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, code)
);

CREATE TABLE journal (
  company_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  PRIMARY KEY (company_id, code)
);

CREATE TABLE journal_entry (
  company_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  journal_code text NOT NULL,
  number       text,
  date         date NOT NULL,
  label        text NOT NULL CHECK (length(trim(label)) > 0),
  reference    text,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  source_type  text NOT NULL CHECK (source_type IN ('manual','sales_document','purchase_document','treasury_movement','reversal')),
  source_id    uuid,
  reversal_of  uuid,
  reversed_by  uuid,
  created_by   uuid REFERENCES user_account(id),
  posted_by    uuid REFERENCES user_account(id),
  posted_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (company_id, journal_code) REFERENCES journal (company_id, code),
  FOREIGN KEY (company_id, reversal_of) REFERENCES journal_entry (company_id, id),
  FOREIGN KEY (company_id, reversed_by) REFERENCES journal_entry (company_id, id),
  CONSTRAINT journal_entry_number_chk CHECK ((status = 'posted') = (number IS NOT NULL))
);
-- Une opération (facture, mouvement de trésorerie) n'est comptabilisée qu'une fois.
CREATE UNIQUE INDEX journal_entry_source_uq ON journal_entry (company_id, source_type, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX journal_entry_date_idx ON journal_entry (company_id, date);

CREATE TABLE journal_line (
  company_id   uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL,
  position     integer NOT NULL,
  account_code text NOT NULL,
  contact_id   uuid,                   -- compte de tiers (client, fournisseur)
  label        text NOT NULL,
  debit        numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, entry_id) REFERENCES journal_entry (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, account_code) REFERENCES ledger_account (company_id, code),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  CONSTRAINT journal_line_one_side_chk CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX journal_line_account_idx ON journal_line (company_id, account_code);
CREATE INDEX journal_line_entry_idx ON journal_line (company_id, entry_id, position);

-- Date jusqu'à laquelle la comptabilité est clôturée (aucune écriture validée à cette date ou avant).
ALTER TABLE company ADD COLUMN accounting_locked_until date;

-- Sous-compte comptable de chaque compte de trésorerie (5711 Caisse principale, 5211 SGCI…)
ALTER TABLE treasury_account ADD COLUMN ledger_code text;

-- ---------------------------------------------------------------------
-- Intégrité comptable
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION journal_entry_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; n integer;
BEGIN
  IF NEW.status <> 'posted' THEN RETURN NULL; END IF;
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO d, c, n
    FROM journal_line WHERE company_id = NEW.company_id AND entry_id = NEW.id;
  IF n < 2 OR d <> c OR d = 0 THEN
    RAISE EXCEPTION 'écriture % déséquilibrée (débit %, crédit %, % lignes)', coalesce(NEW.number, NEW.id::text), d, c, n USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Vérifiée à la validation de la transaction : les lignes sont insérées après l'écriture.
CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT OR UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_check();

CREATE OR REPLACE FUNCTION journal_entry_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN RAISE EXCEPTION 'écriture validée : suppression interdite (contre-passez-la)' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    IF OLD.reversed_by IS NULL AND NEW.reversed_by IS NOT NULL AND (to_jsonb(NEW) - 'reversed_by') = (to_jsonb(OLD) - 'reversed_by') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'écriture validée : modification interdite (contre-passez-la)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'posted' THEN
    SELECT accounting_locked_until INTO locked FROM company WHERE id = NEW.company_id;
    IF locked IS NOT NULL AND NEW.date <= locked THEN
      RAISE EXCEPTION 'période clôturée : aucune écriture au % ou avant (clôture au %)', NEW.date, locked USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_lock BEFORE INSERT OR UPDATE OR DELETE ON journal_entry FOR EACH ROW EXECUTE FUNCTION journal_entry_lock();

-- Toute écriture naît en brouillon puis est validée : ses lignes ne bougent plus ensuite.
CREATE OR REPLACE FUNCTION journal_line_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM journal_entry WHERE company_id = coalesce(NEW.company_id, OLD.company_id) AND id = coalesce(NEW.entry_id, OLD.entry_id);
  IF st = 'posted' THEN
    RAISE EXCEPTION 'écriture validée : lignes non modifiables' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER journal_line_lock BEFORE INSERT OR UPDATE OR DELETE ON journal_line FOR EACH ROW EXECUTE FUNCTION journal_line_lock();

-- ---------------------------------------------------------------------
-- Plan comptable SYSCOHADA révisé (comptes usuels d'une PME) et journaux
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_accounting(p_company uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ledger_account (company_id, code, name, is_system)
  SELECT p_company, code, name, true FROM (VALUES
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

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_account','journal','journal_entry','journal_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON ledger_account TO kora_app;
GRANT SELECT, INSERT ON journal TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_entry, journal_line TO kora_app;
GRANT EXECUTE ON FUNCTION seed_accounting(uuid) TO kora_app;

-- Entreprises existantes : plan comptable, journaux et sous-comptes de trésorerie
SELECT seed_accounting(id) FROM company;

WITH numbered AS (
  SELECT company_id, id, name, CASE kind WHEN 'cash' THEN '571' WHEN 'bank' THEN '521' ELSE '552' END AS root,
         row_number() OVER (PARTITION BY company_id, kind ORDER BY created_at, id) AS n
  FROM treasury_account
)
UPDATE treasury_account a SET ledger_code = nb.root || nb.n FROM numbered nb WHERE a.company_id = nb.company_id AND a.id = nb.id;
INSERT INTO ledger_account (company_id, code, name, is_system)
SELECT company_id, ledger_code, name, true FROM treasury_account ON CONFLICT DO NOTHING;

ALTER TABLE treasury_account ALTER COLUMN ledger_code SET NOT NULL;
ALTER TABLE treasury_account ADD CONSTRAINT treasury_account_ledger_fk FOREIGN KEY (company_id, ledger_code) REFERENCES ledger_account (company_id, code);
CREATE UNIQUE INDEX treasury_account_ledger_uq ON treasury_account (company_id, ledger_code);
