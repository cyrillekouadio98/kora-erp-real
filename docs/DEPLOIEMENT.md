# Déployer Kora ERP pour la phase de test (gratuit)

| Partie | Hébergeur | Offre |
| --- | --- | --- |
| Interface (Next.js) | Vercel | Hobby, gratuite |
| API et tâches de fond (NestJS) | Render | Free |
| Base de données (PostgreSQL) | Neon | Free |

L'offre Hobby de Vercel est réservée aux usages non commerciaux : elle convient aux tests, pas à la vente aux clients. Pour la mise en service réelle, passez à Vercel Pro et à une offre payante de Render (les serveurs gratuits se mettent en veille).

Comptez 30 à 45 minutes. Le code doit être sur GitHub (branche `featureBranch`).

## 1. Base de données sur Neon

1. Créez un compte sur [neon.com](https://neon.com), puis un projet : nom `nora`, région **AWS Europe Central (Frankfurt)**, PostgreSQL 16 ou plus récent.
2. Dans **Connect**, copiez l'adresse de connexion du rôle administrateur (`neondb_owner`), avec `?sslmode=require` à la fin.
3. Sur votre ordinateur, à la racine du projet :

   ```bash
   node infra/db/setup-hosted.mjs "postgres://neondb_owner:MOTDEPASSE@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require"
   ```

   Le script crée les rôles `kora_owner`, `kora_app`, `kora_platform` et la base `kora`, puis affiche trois lignes `DATABASE_…_URL=…`. Gardez-les : elles servent à l'étape 2 et contiennent des mots de passe.

   S'il affiche « kora_owner n'a pas l'attribut BYPASSRLS », arrêtez-vous et signalez-le : les migrations ne passeraient pas.

## 2. API sur Render

1. Créez un compte sur [render.com](https://render.com) et reliez votre compte GitHub.
2. **New › Blueprint**, choisissez le dépôt et la branche `featureBranch`. Render lit `render.yaml` et prépare le service `nora-api`.
3. Renseignez les variables demandées :

   | Variable | Valeur |
   | --- | --- |
   | `WEB_URL` | L'adresse Vercel de l'étape 3, par exemple `https://nora-erp.vercel.app` (mettez une valeur provisoire, vous la corrigerez) |
   | `DATABASE_OWNER_URL`, `DATABASE_APP_URL`, `DATABASE_PLATFORM_URL` | Les trois lignes affichées à l'étape 1 |
   | `ENCRYPTION_KEY` | Le résultat de `openssl rand -base64 32` |
   | `SEED_SUPERADMIN_EMAIL`, `SEED_SUPERADMIN_PASSWORD` | Votre compte de la console éditeur (mot de passe d'au moins 10 caractères) |
   | `SMTP_URL`, `MAIL_FROM` | Voir l'étape 4 ; laissez vide pour commencer |

4. Lancez le déploiement. Au démarrage, Render applique les migrations, crée les formules et votre compte administrateur.
5. Vérifiez : `https://nora-api.onrender.com/health` doit répondre `{"status":"ok"}` (le nom exact du service figure sur Render).

## 3. Interface sur Vercel

1. Créez un compte sur [vercel.com](https://vercel.com) avec GitHub, puis **Add New › Project** et importez le dépôt.
2. Réglages du projet :
   - **Root Directory** : `apps/web`
   - **Framework** : Next.js (détecté automatiquement)
   - **Variable d'environnement** : `API_URL` = l'adresse Render, par exemple `https://nora-api.onrender.com` (sans `/` final)
   - **Branche de production** (Settings › Git) : `featureBranch`
3. Déployez. Vercel donne une adresse en `.vercel.app`.
4. Revenez sur Render et mettez cette adresse exacte dans `WEB_URL` (sans `/` final), puis redéployez l'API : sans cela, les connexions sont refusées (« Origine de la requête non autorisée ») et les liens des e-mails pointent au mauvais endroit.

## 4. E-mails (recommandé)

Sans `SMTP_URL`, aucun e-mail ne part : les invitations restent copiables à l'écran, mais « mot de passe oublié » ne fonctionne pas. Pour les tests, un compte gratuit [Brevo](https://www.brevo.com) suffit :

- `SMTP_URL` = `smtp://IDENTIFIANT:CLE_SMTP@smtp-relay.brevo.com:587`
- `MAIL_FROM` = `"Kora ERP <adresse-verifiee@votre-domaine>"` (une adresse validée chez Brevo)

## 5. Première connexion

1. Ouvrez l'adresse Vercel et connectez-vous avec le compte administrateur de l'étape 2.
2. En production, la console éditeur exige la double authentification : activez-la dans **Ma sécurité**.
3. Les testeurs créent leur entreprise par **Créer mon entreprise** (14 jours d'essai), ou vous la préparez depuis la console.

## Limites de l'offre gratuite

- **Mise en veille** : l'API Render s'endort après 15 minutes sans visite et met environ une minute à se réveiller. Avant une séance de test, ouvrez l'adresse `/health` de l'API et attendez la réponse. Pendant la veille, les e-mails en attente, les rappels et les renouvellements ne sont pas traités ; ils reprennent au réveil.
- **Base** : Neon gratuit offre 0,5 Go, largement assez pour des tests ; la base se met aussi en veille et se réveille en une seconde.
- **Paiements** : l'abonnement se règle par un paiement simulé (`/paiement-test`) ; aucun moyen de paiement réel n'est branché.

## Mettre à jour

Chaque envoi sur `featureBranch` redéploie automatiquement l'interface (Vercel) et l'API (Render), migrations comprises.
