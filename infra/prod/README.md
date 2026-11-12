# Déploiement en production — serveur unique

Kora ERP tourne sur un seul serveur Ubuntu avec Docker Compose :

```
Internet ──443──▶ caddy (HTTPS automatique) ──▶ web (Next.js) ──/api──▶ api (NestJS) ──▶ db (PostgreSQL 16)
```

- Seul **Caddy** publie des ports (80 et 443) ; il obtient et renouvelle le certificat Let's Encrypt.
- La **base** et l'**API** ne sont joignables que sur le réseau interne de Docker : aucune connexion PostgreSQL ne passe par Internet.
- PostgreSQL est installé avec un superutilisateur : les trois rôles de Kora (`kora_owner` avec `BYPASSRLS`, `kora_app`, `kora_platform`) sont créés au premier démarrage par `db-init.sh`.
- Les migrations et les données de référence s'appliquent à chaque démarrage de l'API (idempotents).

| Fichier | Rôle |
| --- | --- |
| `docker-compose.yml` | Les quatre services, journaux bornés, contrôles de santé |
| `Caddyfile` | HTTPS et en-têtes de sécurité |
| `db-init.sh` | Rôles et base au premier démarrage (mots de passe de `.env`) |
| `generate-env.sh` | Génère `.env` avec des secrets aléatoires (une seule fois) |
| `setup-server.sh` | Docker, pare-feu, mises à jour de sécurité, fail2ban, swap, sauvegarde nocturne |
| `deploy.sh` | Mise à jour depuis la branche `prod` : sauvegarde, build, redémarrage, contrôle de santé |
| `backup.sh` | Sauvegarde `pg_dump` (14 jours conservés) |

## Prérequis

- Un serveur **Ubuntu 22.04 ou 24.04**, 2 cœurs et 4 Go de RAM recommandés (la construction de l'interface est gourmande).
- Un **nom de domaine** dont l'enregistrement DNS `A` pointe vers l'IP publique du serveur (nécessaire au certificat HTTPS).
- Un accès SSH par **clé** (pas de mot de passe).

## Première installation

Toutes les commandes se lancent sur le serveur, en root.

**1. Clé de déploiement GitHub** (le dépôt est privé) : le serveur lit le dépôt avec une clé en lecture seule.

```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/kora_deploy -C "kora-prod"
cat /root/.ssh/kora_deploy.pub
```

Ajoutez cette clé publique dans GitHub : dépôt → *Settings* → *Deploy keys* → *Add deploy key*, **sans** cocher *Allow write access*. Puis :

```bash
cat >> /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/kora_deploy
  IdentitiesOnly yes
EOF
git clone -b prod git@github.com:cyrillekouadio98/kora-erp-real.git /opt/kora
```

**2. Préparation du serveur**

```bash
bash /opt/kora/infra/prod/setup-server.sh
```

**3. Secrets** (domaine et e-mail de l'administrateur) :

```bash
/opt/kora/infra/prod/generate-env.sh app.exemple.ci admin@exemple.ci
```

Le script affiche le mot de passe du super administrateur : notez-le. Copiez aussi `/opt/kora/infra/prod/.env` dans un coffre de mots de passe : **sans ce fichier, une sauvegarde ne peut pas être restaurée à l'identique** (clé de chiffrement de la double authentification, mots de passe de la base).

**4. Déploiement**

```bash
/opt/kora/infra/prod/deploy.sh
```

L'application est alors en ligne sur `https://<domaine>`. Connectez-vous avec le super administrateur, activez la double authentification (« Ma sécurité »), puis retirez les lignes `SEED_SUPERADMIN_*` de `.env`.

## Mettre à jour

Poussez sur la branche `prod`, puis sur le serveur :

```bash
/opt/kora/infra/prod/deploy.sh
```

Une sauvegarde est faite avant chaque mise à jour. Si l'API ne démarre pas (migration en échec, variable manquante), le script affiche ses journaux et s'arrête.

## Exploitation

```bash
cd /opt/kora/infra/prod
docker compose --env-file .env ps                 # état des services
docker compose --env-file .env logs -f api        # journaux de l'API
docker compose --env-file .env exec db psql -U postgres -d kora   # console SQL
./backup.sh                                       # sauvegarde immédiate
```

### Sauvegardes

`backup.sh` tourne chaque nuit (2 h 30 UTC) et garde 14 jours dans `infra/prod/backups/`. Ces fichiers restent **sur le même disque** que la base : copiez-les régulièrement ailleurs (stockage d'objets, autre machine), sinon la perte du serveur emporte aussi les sauvegardes.

Restauration dans une base vide :

```bash
docker compose --env-file .env exec -T db pg_restore -U postgres -d kora --clean --if-exists < backups/kora-AAAAMMJJ-HHMMSS.dump
```

Testez une restauration au moins une fois avant la mise en service.

## Points d'attention

- **Ne régénérez jamais `.env`** une fois la base créée : les mots de passe des rôles et `ENCRYPTION_KEY` doivent rester identiques (`generate-env.sh` refuse d'écraser un fichier existant).
- **Région** : si le serveur est hébergé hors de Côte d'Ivoire, vérifiez les formalités ARTCI pour le transfert de données personnelles.
- **Paiement en ligne** : le prestataire de test n'existe pas en production. Tant qu'un prestataire réel n'est pas branché, les abonnements se règlent par virement saisi dans la console éditeur.
- **E-mails** : l'envoi n'est pas encore branché ; les liens d'invitation s'affichent à l'administrateur.
