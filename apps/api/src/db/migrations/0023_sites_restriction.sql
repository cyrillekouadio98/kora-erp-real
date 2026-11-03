-- =====================================================================
-- Kora ERP — Migration 0023 : utilisateurs limités à certains sites
-- La base elle-même cache à un utilisateur limité les documents des autres sites (ventes, achats,
-- documents de stock, caisses et comptes, employés, écritures) et l'empêche d'en créer pour eux.
-- Un transfert reste visible du site qui reçoit la marchandise. Sans limite, rien ne change.
-- =====================================================================

-- Sites permis pour la transaction en cours (NULL : tous) ; posé par l'API pour chaque requête.
CREATE FUNCTION app_site_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN coalesce(current_setting('app.site_ids', true), '') = '' THEN NULL
              ELSE string_to_array(current_setting('app.site_ids', true), ',')::uuid[] END
$$;
GRANT EXECUTE ON FUNCTION app_site_ids() TO kora_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_document','purchase_document','treasury_account','employee','journal_entry']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO kora_app USING (app_site_ids() IS NULL OR site_id = ANY (app_site_ids())) WITH CHECK (app_site_ids() IS NULL OR site_id = ANY (app_site_ids()))', t || '_site', t);
  END LOOP;
END $$;

CREATE POLICY stock_document_site ON stock_document AS RESTRICTIVE FOR ALL TO kora_app
  USING (app_site_ids() IS NULL OR site_id = ANY (app_site_ids())
         OR EXISTS (SELECT 1 FROM warehouse w WHERE w.company_id = stock_document.company_id AND w.id = stock_document.dest_warehouse_id AND w.site_id = ANY (app_site_ids())))
  WITH CHECK (app_site_ids() IS NULL OR site_id = ANY (app_site_ids())
         OR EXISTS (SELECT 1 FROM warehouse w WHERE w.company_id = stock_document.company_id AND w.id = stock_document.dest_warehouse_id AND w.site_id = ANY (app_site_ids())));
