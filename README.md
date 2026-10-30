# Kora ERP

ERP SaaS multi-entreprises pour les PME d'Afrique de l'Ouest : gestion commerciale, comptabilité SYSCOHADA révisé, trésorerie, ressources humaines et paie. Marché initial : Côte d'Ivoire.

> Nom provisoire. Ce dépôt contient la **phase 2 — socle SaaS** du dossier de conception validé : comptes, entreprises, rôles et permissions, abonnements, journal d'audit, accès exceptionnel du support et isolation des données. Le premier module métier de la phase 3, **clients et fournisseurs**, est disponible ; les autres (ventes, comptabilité, caisse, banque, paie) arrivent aux phases 3 à 5.

## Ce que fait le socle

| Domaine | Fonctionnalités |
| --- | --- |
| Comptes | Inscription avec création de l'entreprise et essai gratuit, connexion, double authentification (TOTP), verrouillage après 5 échecs, sessions révocables, changement de mot de passe |
| Multi-entreprises | Un utilisateur peut appartenir à plusieurs entreprises, avec un rôle différent dans chacune, et changer d'entreprise active sans se reconnecter |
| Rôles et permissions | 10 rôles standard (propriétaire, directeur, comptable, caissier, RH, paie, auditeur…), rôles personnalisés, 7 actions par module, permissions sensibles réservées au propriétaire, accès limités dans le temps |
| Invitations | Lien d'invitation valable 7 jours, à usage unique, création de compte ou rattachement d'un compte existant |
| Abonnements | Formules versionnées (Starter, Business, Premium, Cabinet, Enterprise), droits et quotas vérifiés côté serveur, essai, renouvellement, prorata, période de grâce, suspension, résiliation, archivage, factures et rappels |
| Paiements | Interface commune aux prestataires, prestataire de test signé (HMAC), notifications traitées une seule fois, virements saisis par l'éditeur |
| Console éditeur | Clients, indicateurs (revenu récurrent estimé, facturé, encaissé, impayés), suspension motivée, gestion des formules |
| Support | Accès aux données d'un client uniquement après son accord, pour une durée et un périmètre limités, chaque consultation étant inscrite dans son journal |
| Clients et fournisseurs | Fiche tiers (client, fournisseur ou les deux, NCC, RCCM, délai de paiement), numérotation automatique CLI-/FRS-/TIE-, recherche, archivage au lieu de suppression, export CSV, journal d'audit |
| Réversibilité | Export complet des données de l'entreprise (JSON + CSV), toujours possible même en cas de suspension |

## Sécurité et isolation des données

L'isolation entre entreprises repose sur quatre verrous indépendants :

1. **Session** : l'entreprise active est lue dans la session côté serveur, jamais dans l'URL.
2. **Code** : une garde unique vérifie session → double authentification → adhésion → abonnement → permission sur chaque route.
3. **Base de données** : sécurité au niveau des lignes (RLS) PostgreSQL activée et **forcée** sur toutes les tables portant `company_id`, rôle applicatif sans privilège de contournement, clés étrangères composites `(company_id, id)`.
4. **Rôles PostgreSQL séparés** : `kora_app` (API, soumis à la RLS), `kora_platform` (console éditeur, sans aucun droit sur les données métier), `kora_owner` (migrations uniquement).

La suite `apps/api/test/isolation.spec.ts` le prouve à chaque modification : elle appelle **toutes les routes de l'API** en tant qu'utilisateur d'une entreprise A avec les identifiants de l'entreprise B, et échoue au moindre accès ou à la moindre fuite. Elle vérifie aussi qu'aucune table métier n'échappe à la RLS et que chaque route déclare son niveau d'accès.

## Démarrer

### En une commande (sans Docker)

Prérequis : Node.js 22 uniquement. PostgreSQL 16 est fourni par le paquet `embedded-postgres` (données dans `.pgdata/`).

```bash
npm install
npm run dev        # PostgreSQL + migrations + données de référence + API + interface
```

Ouvrez http://localhost:3000 et créez votre entreprise via « Créer un compte ». Ctrl+C arrête tout.
`npm run dev:db` lance uniquement PostgreSQL (utile pour `npm test` ou pour lancer l'API et l'interface séparément).

### Avec Docker

```bash
docker compose up --build
```

Interface : http://localhost:3000 · API : http://localhost:3001 · documentation de l'API (OpenAPI) : http://localhost:3001/docs

### Sans Docker

Prérequis : Node.js 22, PostgreSQL 16.

```bash
# 1. Rôles et bases (une fois, avec un superutilisateur PostgreSQL)
psql -U postgres -f infra/db/init.sql
psql -U postgres -c "CREATE DATABASE kora OWNER kora_owner"
psql -U postgres -c "CREATE DATABASE kora_test OWNER kora_owner"

# 2. Dépendances, migrations, données de référence
npm install
cp .env.example .env            # puis adaptez les valeurs
npm run db:migrate
npm run db:seed                 # formules par défaut + super administrateur (SEED_SUPERADMIN_*)

# 3. Lancer l'API et l'interface (deux terminaux)
npm run dev:api
npm run dev:web
```

Le super administrateur doit activer la double authentification (menu « Ma sécurité ») avant d'accéder à la console éditeur.

### Tests

```bash
npm test
```

46 tests d'intégration sur une vraie base PostgreSQL (`kora_test`, recréée à chaque fichier ; PostgreSQL doit tourner, par exemple via `npm run dev:db`) : authentification, rôles et quotas, abonnements et paiements, console éditeur et support, contacts, isolation multi-entreprises. Par sécurité, les tests refusent de s'exécuter sur une base dont le nom ne se termine pas par `_test`.

## Organisation du code

```
apps/
  api/                 API NestJS (TypeScript)
    src/common/        garde d'accès, erreurs, validation, chiffrement
    src/db/            migrations SQL versionnées, accès PostgreSQL (Kysely), contexte RLS
    src/modules/       auth, companies, rbac, billing, audit, support, platform, exports, contacts
    test/              tests d'intégration
  web/                 interface Next.js (espace entreprise + console éditeur)
infra/db/              création des rôles et des bases PostgreSQL, PostgreSQL local (dev-postgres.mjs)
scripts/dev.mjs        lancement de tout l'environnement en une commande
.github/workflows/     intégration continue (types, tests, construction)
```

## Reste à faire

- **Phase 3 — gestion commerciale** : articles et stocks, devis → commandes → factures clients (facture normalisée DGI), achats et factures fournisseurs, caisse, règlements et relances. Les contacts servent de base à tous ces documents.
- **Phase 4 — finance** : plan comptable SYSCOHADA révisé, journaux et écritures générées automatiquement, banque et rapprochement, grand livre, balance, états financiers, déclarations TVA.
- **Phase 5 — RH et paie** : employés, congés, paie ivoirienne (ITS, CNPS, CMU), bulletins, espace employé.
- **Socle** : envoi réel des e-mails (invitations, rappels), prestataire de paiement réel, téléversement du logo, verrou du cycle de facturation si plusieurs instances de l'API.

## Décisions encore ouvertes

- Prestataire de paiement réel (agrégateur mobile money + carte) : l'interface `PaymentProvider` est prête, seul le prestataire de test est branché.
- Envoi des e-mails (invitations, rappels de paiement) : les notifications sont enregistrées, l'envoi reste à brancher.
- Hébergement et formalités ARTCI pour les données personnelles.
- Facture normalisée électronique de la DGI : à intégrer au module ventes (phase 3) dès réception des spécifications.
- Prix des formules : les montants de `apps/api/src/modules/billing/entitlements.ts` sont des exemples à valider.
