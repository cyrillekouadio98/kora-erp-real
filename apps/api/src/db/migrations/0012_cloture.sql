-- =====================================================================
-- Kora ERP — Migration 0012 : clôture d'exercice
-- L'exercice coïncide avec l'année civile (Acte uniforme OHADA relatif au droit comptable).
-- La clôture solde les comptes de gestion (classes 6, 7 et 8) dans le résultat (131 / 139)
-- puis verrouille l'exercice. La comptabilité étant continue, les soldes de clôture des
-- comptes de bilan sont les soldes d'ouverture de l'exercice suivant.
-- =====================================================================
CREATE TABLE fiscal_year_closing (
  company_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  year       integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  result     numeric(18,2) NOT NULL,
  entry_id   uuid,
  warnings   jsonb NOT NULL DEFAULT '[]',        -- points signalés et acceptés au moment de la clôture
  closed_by  uuid REFERENCES user_account(id),
  closed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, year),
  FOREIGN KEY (company_id, entry_id) REFERENCES journal_entry (company_id, id)
);
ALTER TABLE fiscal_year_closing ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_year_closing FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_year_closing_tenant ON fiscal_year_closing FOR ALL TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON fiscal_year_closing TO kora_app;

ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_type_chk;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_type_chk
  CHECK (source_type IN ('manual','sales_document','purchase_document','treasury_movement','treasury_opening','stock_opening','stock_variation','payroll_run','year_closing','reversal'));

-- L'écriture de clôture d'exercice (détermination du résultat) reste possible dans une période
-- verrouillée : elle ne fait que reclasser les comptes de gestion dans le résultat, et seule la
-- procédure de clôture (permission sensible « clôturer ») la produit.
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
  IF NEW.status = 'posted' AND NEW.source_type <> 'year_closing' THEN
    SELECT accounting_locked_until INTO locked FROM company WHERE id = NEW.company_id;
    IF locked IS NOT NULL AND NEW.date <= locked THEN
      RAISE EXCEPTION 'période clôturée : aucune écriture au % ou avant (clôture au %)', NEW.date, locked USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
