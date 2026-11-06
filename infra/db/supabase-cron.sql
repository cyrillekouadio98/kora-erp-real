-- =====================================================================
-- Kora ERP — tâches de fond déclenchées par Supabase (pg_cron + pg_net)
-- À exécuter une fois dans l'éditeur SQL de Supabase, après avoir remplacé les deux valeurs entre chevrons :
--   <ADRESSE_API> : l'adresse du projet Vercel de l'API, sans « / » final (ex. https://kora-erp-api.vercel.app)
--   <CRON_SECRET> : la même valeur que la variable CRON_SECRET de ce projet Vercel
-- Chaque minute, Supabase appelle POST <ADRESSE_API>/jobs/tick : envoi des e-mails en attente, rappels du calendrier,
-- et toutes les 10 minutes le cycle des abonnements. Les deux valeurs sont rangées dans le coffre (Vault) de Supabase.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<ADRESSE_API>', 'kora_api_url', 'Adresse de l''API Kora ERP');
select vault.create_secret('<CRON_SECRET>', 'kora_cron_secret', 'Secret de POST /jobs/tick');

select cron.schedule('kora-taches', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'kora_api_url') || '/jobs/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kora_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);

-- Vérifier les derniers appels (status_code 200 attendu) :
--   select status_code, content, created from net._http_response order by created desc limit 5;
-- Changer une valeur plus tard :
--   select vault.update_secret((select id from vault.secrets where name = 'kora_cron_secret'), '<NOUVEAU_SECRET>');
-- Arrêter les tâches :
--   select cron.unschedule('kora-taches');
