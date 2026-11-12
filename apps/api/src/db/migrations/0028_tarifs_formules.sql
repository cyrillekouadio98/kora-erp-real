-- Nouveaux tarifs : Starter 20 000 F / mois et 5 utilisateurs, Business 40 000 F et 10 utilisateurs,
-- Cabinet 150 000 F sans limite d'utilisateurs. Une nouvelle version publiée par formule :
-- les nouveaux abonnements la prennent, les abonnements existants restent sur leur version.
-- (Base vide : rien à faire ici, les formules sont créées par le seed avec ces valeurs.)
WITH tarifs(code, monthly, yearly, users) AS (VALUES
  ('starter', 20000, 200000, '5'::jsonb), ('business', 40000, 400000, '10'::jsonb), ('cabinet', 150000, 1500000, 'null'::jsonb)),
latest AS (
  SELECT DISTINCT ON (v.plan_id) v.*, t.monthly, t.yearly, t.users
  FROM plan_version v JOIN plan p ON p.id = v.plan_id JOIN tarifs t ON t.code = p.code
  WHERE v.published_at IS NOT NULL ORDER BY v.plan_id, v.version DESC)
INSERT INTO plan_version (plan_id, version, currency, price_monthly, price_yearly, trial_days, grace_days, entitlements, published_at)
SELECT l.plan_id, (SELECT max(version) + 1 FROM plan_version WHERE plan_id = l.plan_id), l.currency, l.monthly, l.yearly, l.trial_days, l.grace_days,
       jsonb_set(l.entitlements, '{quotas,users}', l.users), now()
FROM latest l
WHERE l.price_monthly <> l.monthly OR l.entitlements #> '{quotas,users}' IS DISTINCT FROM l.users;
