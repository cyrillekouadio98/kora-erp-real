-- =====================================================================
-- Kora ERP — Migration 0025 : calendrier et rendez-vous
-- Rendez-vous de l'entreprise (réunion, appel, visite client, livraison…) : horaire, lieu,
-- client ou fournisseur concerné, participants (utilisateurs Kora), rappel par e-mail.
-- Chaque rendez-vous appartient à un site, comme les autres documents.
-- =====================================================================

CREATE TABLE appointment (
  company_id        uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL,
  title             text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  kind              text NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting','call','visit','delivery','other')),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  all_day           boolean NOT NULL DEFAULT false,
  location          text,
  notes             text,
  contact_id        uuid,
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','cancelled')),
  reminder_minutes  integer CHECK (reminder_minutes BETWEEN 0 AND 10080),
  reminded_at       timestamptz,
  created_by        uuid REFERENCES user_account(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contact (company_id, id),
  CONSTRAINT appointment_period_chk CHECK (end_at >= start_at AND end_at - start_at <= interval '31 days')
);
CREATE INDEX appointment_start_idx ON appointment (company_id, start_at);
CREATE INDEX appointment_reminder_idx ON appointment (start_at) WHERE status = 'planned' AND reminder_minutes IS NOT NULL AND reminded_at IS NULL;
CREATE TRIGGER appointment_touch BEFORE UPDATE ON appointment FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER appointment_site BEFORE INSERT ON appointment FOR EACH ROW EXECUTE FUNCTION assign_site();

CREATE TABLE appointment_attendee (
  company_id     uuid NOT NULL,
  appointment_id uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES user_account(id),
  PRIMARY KEY (company_id, appointment_id, user_id),
  FOREIGN KEY (company_id, appointment_id) REFERENCES appointment (company_id, id) ON DELETE CASCADE
);
CREATE INDEX appointment_attendee_user_idx ON appointment_attendee (company_id, user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointment','appointment_attendee']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kora_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON appointment, appointment_attendee TO kora_app;

-- Rappels : la tâche planifiée (rôle de la plateforme) lit les rendez-vous dus et met en file les e-mails.
GRANT SELECT, UPDATE ON appointment TO kora_platform;
GRANT SELECT ON appointment_attendee TO kora_platform;
GRANT INSERT ON email_message TO kora_platform;
CREATE POLICY appointment_platform ON appointment FOR ALL TO kora_platform USING (true) WITH CHECK (true);
CREATE POLICY appointment_attendee_platform ON appointment_attendee FOR SELECT TO kora_platform USING (true);

-- Droits du nouveau module « Calendrier » pour les rôles standard.
CREATE OR REPLACE FUNCTION pg_temp.grant_to_role(role_key text, perms text[]) RETURNS void LANGUAGE sql AS $$
  UPDATE role SET permissions = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(permissions || perms) p)
   WHERE is_system AND key = role_key;
$$;
SELECT pg_temp.grant_to_role('owner', ARRAY['calendar.read','calendar.create','calendar.update','calendar.validate','calendar.cancel','calendar.export','calendar.admin']);
SELECT pg_temp.grant_to_role('director', ARRAY['calendar.read','calendar.create','calendar.update','calendar.cancel']);
SELECT pg_temp.grant_to_role('accountant', ARRAY['calendar.read','calendar.create','calendar.update']);
SELECT pg_temp.grant_to_role('finance_manager', ARRAY['calendar.read','calendar.create','calendar.update']);
SELECT pg_temp.grant_to_role('cashier', ARRAY['calendar.read']);
SELECT pg_temp.grant_to_role('sales_rep', ARRAY['calendar.read','calendar.create','calendar.update','calendar.cancel']);
SELECT pg_temp.grant_to_role('storekeeper', ARRAY['calendar.read','calendar.create','calendar.update']);
SELECT pg_temp.grant_to_role('hr_manager', ARRAY['calendar.read','calendar.create','calendar.update','calendar.cancel']);
SELECT pg_temp.grant_to_role('payroll_manager', ARRAY['calendar.read']);
SELECT pg_temp.grant_to_role('auditor', ARRAY['calendar.read']);
