-- Rôles cloisonnés par entreprise.
--
-- La politique role_own_memberships laissait un utilisateur lire les rôles de toutes ses entreprises,
-- même dans le contexte d'une seule : une recherche « le rôle owner » pouvait renvoyer celui d'une autre
-- entreprise (remise d'une entreprise préparée par un éditeur qui a aussi la sienne). Elle ne s'applique
-- plus qu'en l'absence de contexte d'entreprise.
DROP POLICY role_own_memberships ON role;
CREATE POLICY role_own_memberships ON role FOR SELECT TO kora_app USING (
  app_company_id() IS NULL
  AND EXISTS (SELECT 1 FROM company_membership m WHERE m.company_id = role.company_id AND m.user_id = app_user_id()));

-- Invitations en attente portant un rôle d'une autre entreprise : remplacé par le rôle de même clé
-- de l'entreprise invitante (les rôles sans équivalent sont retirés).
UPDATE invitation i SET role_ids = coalesce((
  SELECT array_agg(DISTINCT own.id)
  FROM unnest(i.role_ids) AS rid
  JOIN role r ON r.id = rid
  JOIN role own ON own.company_id = i.company_id AND own.key = r.key
), '{}')
WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM unnest(i.role_ids) AS rid JOIN role r ON r.id = rid WHERE r.company_id <> i.company_id);

-- Propriétaires restés sans rôle (invitation acceptée avec un rôle d'une autre entreprise) : rôle Propriétaire rendu.
INSERT INTO membership_role (company_id, membership_id, role_id)
SELECT m.company_id, m.id, r.id
FROM company_membership m
JOIN role r ON r.company_id = m.company_id AND r.key = 'owner'
WHERE m.is_owner
  AND NOT EXISTS (SELECT 1 FROM membership_role mr WHERE mr.membership_id = m.id);
