# Déployer Kora ERP sur Supabase et Vercel (phase de test)

| Partie | Hébergeur | Où |
| --- | --- | --- |
| Base de données (PostgreSQL) | Supabase, offre Free | Schéma `kora` de la base `postgres` |
| API (NestJS) | Vercel, projet n° 1 | Dossier `apps/api` |
| Interface (Next.js) | Vercel, projet n° 2 | Dossier `apps/web` |
| Tâches de fond (e-mails, rappels, abonnements) | Supabase `pg_cron`, chaque minute | Appelle l'API |

Vercel éteint l'API entre deux requêtes : les tâches de fond ne tournent donc pas en continu. Supabase appelle chaque minute l'adresse `/jobs/tick` de l'API, qui envoie les e-mails en attente et les rappels, et lance toutes les 10 minutes le cycle des abonnements.

L'offre Hobby de Vercel est réservée aux usages non commerciaux : elle convient aux tests. Pour la vente aux clients, passez à Vercel Pro.

Comptez 45 minutes. Le code doit être sur GitHub (branche `featureBranch`). Gardez un fichier texte ouvert pour noter les valeurs au fil des étapes.

## 1. Base de données sur Supabase

1. Créez un compte sur [supabase.com](https://supabase.com), puis un projet : nom `kora`, région **Central EU (Frankfurt)**, un mot de passe de base solide (notez-le).
2. **Project Settings › Data API** : laissez le schéma exposé à `public` seulement. Les tables de Kora seront dans le schéma `kora`, que l'API publique de Supabase ne sert pas.
3. Bouton **Connect** en haut du tableau de bord, onglet **Session pooler** : copiez l'adresse. Elle ressemble à `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres` ; remplacez `[YOUR-PASSWORD]` par le mot de passe de l'étape 1.
4. Sur votre ordinateur, à la racine du projet, choisissez le compte de la console éditeur puis lancez :

   ```bash
   SEED_SUPERADMIN_EMAIL=vous@exemple.ci SEED_SUPERADMIN_PASSWORD='UnMotDePasseSolide-2026' \
     node infra/db/setup-hosted.mjs "postgresql://postgres.abcdefgh:MOTDEPASSE@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
   ```

   Le script crée les rôles `kora_owner`, `kora_app`, `kora_platform` et le schéma `kora`, applique toutes les migrations, crée les formules et votre compte, puis affiche trois lignes `DATABASE_…_URL=…`. Notez-les : elles contiennent des mots de passe.

   S'il s'arrête sur « kora_owner n'a pas l'attribut BYPASSRLS », envoyez le message : il faudra adapter la création des rôles.

## 2. API sur Vercel (projet n° 1)

1. Sur [vercel.com](https://vercel.com) : **Add New › Project**, importez le dépôt.
2. Réglages :
   - **Project Name** : `kora-erp-api`
   - **Root Directory** : `apps/api` (Vercel reconnaît NestJS seul ; ne choisissez pas d'autre framework)
3. **Environment Variables** :

   | Variable | Valeur |
   | --- | --- |
   | `DATABASE_OWNER_URL`, `DATABASE_APP_URL`, `DATABASE_PLATFORM_URL` | Les trois lignes de l'étape 1 |
   | `WEB_URL` | L'adresse de l'interface, par exemple `https://kora-erp-real.vercel.app` (sans `/` final) |
   | `ENCRYPTION_KEY` | Le résultat de `openssl rand -base64 32` |
   | `PAYMENT_SANDBOX_SECRET` | Le résultat de `openssl rand -hex 16` |
   | `CRON_SECRET` | Le résultat de `openssl rand -hex 24` (servira aussi à l'étape 4) |
   | `JOBS_ENABLED` | `false` |
   | `DB_POOL_MAX` | `3` |
   | `SMTP_URL`, `MAIL_FROM` | Voir l'étape 5 ; à ajouter plus tard |

4. **Settings › Git** : branche de production `featureBranch`. Déployez.
5. Vérifiez : `https://kora-erp-api.vercel.app/health` doit répondre `{"status":"ok"}`.

## 3. Interface sur Vercel (projet n° 2)

Si vous avez déjà un projet Vercel pour Kora (par exemple `kora-erp-real`), réutilisez-le pour l'interface : son adresse est celle que vos testeurs utiliseront.

1. **Settings › General › Root Directory** : `apps/web` (framework Next.js).
2. **Settings › Environment Variables** : une seule variable, `API_URL` = l'adresse de l'API de l'étape 2 (`https://kora-erp-api.vercel.app`, sans `/` final). Supprimez toute autre variable (bases de données, secrets) : elles n'ont rien à faire dans l'interface.
3. **Settings › Git** : branche de production `featureBranch`. Redéployez.
4. Si l'adresse finale de l'interface diffère de `WEB_URL` (étape 2), corrigez `WEB_URL` dans le projet de l'API et redéployez-le : sinon les connexions sont refusées (« Origine de la requête non autorisée »).

## 4. Tâches de fond (Supabase)

1. Ouvrez [infra/db/supabase-cron.sql](../infra/db/supabase-cron.sql), remplacez `<ADRESSE_API>` (étape 2) et `<CRON_SECRET>` (même valeur que dans Vercel).
2. Dans Supabase, **SQL Editor**, collez le tout et exécutez.
3. Après deux minutes, vérifiez dans le même éditeur :

   ```sql
   select status_code, content, created from net._http_response order by created desc limit 5;
   ```

   `status_code` doit valoir `200`. Un `404` signifie que le secret ne correspond pas à `CRON_SECRET`.

## 5. E-mails (recommandé)

Sans `SMTP_URL`, aucun e-mail ne part : les invitations restent copiables à l'écran, mais « mot de passe oublié » ne fonctionne pas. Pour les tests, un compte gratuit [Brevo](https://www.brevo.com) suffit. Dans le projet Vercel de l'API :

- `SMTP_URL` = `smtp://IDENTIFIANT:CLE_SMTP@smtp-relay.brevo.com:587`
- `MAIL_FROM` = `Kora ERP <adresse-verifiee@votre-domaine>` (une adresse validée chez Brevo)

Puis redéployez l'API.

## 6. Première connexion

1. Ouvrez l'adresse de l'interface et connectez-vous avec le compte de l'étape 1.
2. En production, la console éditeur exige la double authentification : activez-la dans **Ma sécurité**.
3. Les testeurs créent leur entreprise par **Créer mon entreprise** (14 jours d'essai), ou vous la préparez depuis la console.

## Mettre à jour

- **Code** : chaque envoi sur `featureBranch` redéploie l'interface et l'API.
- **Base** : quand une mise à jour ajoute une migration (fichier dans `apps/api/src/db/migrations`), appliquez-la depuis votre poste avec l'adresse `DATABASE_OWNER_URL` :

  ```bash
  DATABASE_OWNER_URL="postgresql://kora_owner.abcdefgh:…@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=no-verify" npm run db:migrate
  ```

  Faites-le avant le redéploiement de l'API qui en a besoin.

## Bon à savoir

- **Mise en veille de Supabase** : un projet gratuit inactif pendant une semaine est mis en pause ; on le relance d'un clic depuis le tableau de bord.
- **Connexion chiffrée** : les adresses Supabase utilisent `sslmode=no-verify` : la connexion est chiffrée, mais le certificat de Supabase (signé par sa propre autorité) n'est pas vérifié.
- **Paiements** : l'abonnement se règle par un paiement simulé (`/paiement-test`) ; aucun moyen de paiement réel n'est branché.
- **Autre hébergement de l'API** : [render.yaml](../render.yaml) décrit l'API sur Render, où elle tourne en continu ; dans ce cas `JOBS_ENABLED` reste à `true` et l'étape 4 est inutile.
