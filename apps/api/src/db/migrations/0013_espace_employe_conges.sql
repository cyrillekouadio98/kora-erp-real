-- =====================================================================
-- Kora ERP — Migration 0013 : espace employé et congés
-- Un employé peut être rattaché à un compte utilisateur (invitation avec le rôle « Employé ») :
-- il consulte alors ses bulletins validés et gère ses demandes de congés.
-- =====================================================================

ALTER TABLE employee
  ADD COLUMN user_id uuid REFERENCES user_account(id),
  ADD COLUMN leave_opening_balance numeric(6,2) NOT NULL DEFAULT 0,   -- jours restant dus au démarrage dans Kora
  ADD COLUMN leave_opening_date date,                                -- début de l'acquisition dans Kora (défaut : embauche)
  ADD CONSTRAINT employee_user_uq UNIQUE (company_id, user_id);

-- Invitation destinée à un employé : la fiche est rattachée au compte à l'acceptation.
ALTER TABLE invitation ADD COLUMN employee_id uuid,
  ADD CONSTRAINT invitation_employee_fk FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id);

CREATE TABLE leave_request (
  company_id    uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  type          text NOT NULL CHECK (type IN ('annual','sick','maternity','family_event','unpaid','other')),
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  days          numeric(5,1) NOT NULL CHECK (days > 0),              -- jours ouvrables décomptés
  reason        text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','refused','cancelled')),
  decided_by    uuid REFERENCES user_account(id),
  decided_at    timestamptz,
  decision_note text,
  created_by    uuid REFERENCES user_account(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employee (company_id, id),
  CHECK (end_date >= start_date)
);
CREATE INDEX leave_request_employee_idx ON leave_request (company_id, employee_id, start_date);

ALTER TABLE leave_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_request FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_request_tenant ON leave_request FOR ALL TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON leave_request TO kora_app;
