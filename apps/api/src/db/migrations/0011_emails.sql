-- =====================================================================
-- Kora ERP — Migration 0011 : envoi des e-mails, mot de passe oublié, liens de consultation
-- Les e-mails sont d'abord enregistrés (file d'envoi), puis envoyés par une tâche de fond
-- qui réessaie en cas d'échec. Aucun secret n'est stocké en clair : seuls des empreintes
-- (SHA-256) des jetons de réinitialisation et de partage sont conservées.
-- =====================================================================

CREATE TABLE email_message (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid REFERENCES company(id) ON DELETE CASCADE,   -- vide : e-mail de la plateforme (mot de passe oublié)
  to_address   text NOT NULL CHECK (position('@' in to_address) > 1),
  reply_to     text,
  from_name    text NOT NULL,
  subject      text NOT NULL,
  text_body    text NOT NULL,
  html_body    text NOT NULL,
  kind         text NOT NULL,           -- invitation, password_reset, sales_document, reminder…
  entity_id    text,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  sent_at      timestamptz,
  created_by   uuid REFERENCES user_account(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_message_queue_idx ON email_message (next_attempt_at) WHERE status = 'queued';
CREATE INDEX email_message_company_idx ON email_message (company_id, created_at DESC);

CREATE TABLE password_reset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Lien de consultation d'un document de vente envoyé à un client (sans compte)
CREATE TABLE document_share (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  views       integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_by  uuid REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES sales_document (company_id, id)
);

-- Sécurité au niveau des lignes
ALTER TABLE email_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_message FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON email_message TO kora_app;
-- Lecture : les e-mails de l'entreprise active ; ceux de la plateforme seulement en mode authentification (pour RETURNING).
CREATE POLICY email_app_select ON email_message FOR SELECT TO kora_app
  USING (company_id = app_company_id() OR (company_id IS NULL AND app_identity_lookup()));
CREATE POLICY email_app_insert ON email_message FOR INSERT TO kora_app
  WITH CHECK (company_id = app_company_id() OR (company_id IS NULL AND app_identity_lookup()));
-- La tâche d'envoi tourne avec le rôle de la plateforme, qui n'a accès qu'à cette file.
GRANT SELECT, UPDATE ON email_message TO kora_platform;
CREATE POLICY email_platform ON email_message FOR ALL TO kora_platform USING (true) WITH CHECK (true);

-- Réinitialisation : uniquement par le code d'authentification (mode identity_lookup)
ALTER TABLE password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON password_reset TO kora_app;
CREATE POLICY password_reset_identity ON password_reset FOR ALL TO kora_app USING (app_identity_lookup()) WITH CHECK (app_identity_lookup());

ALTER TABLE document_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_share FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON document_share TO kora_app;
CREATE POLICY document_share_tenant ON document_share FOR ALL TO kora_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
