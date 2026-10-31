# Kora ERP

ERP SaaS multi-entreprises pour les PME d'Afrique de l'Ouest : gestion commerciale, comptabilité SYSCOHADA révisé, trésorerie, ressources humaines et paie. Marché initial : Côte d'Ivoire.

> Nom provisoire. Ce dépôt contient la **phase 2 — socle SaaS** du dossier de conception validé : comptes, entreprises, rôles et permissions, abonnements, journal d'audit, accès exceptionnel du support et isolation des données. Modules métier de la phase 3 disponibles : **clients et fournisseurs, articles, ventes** (devis, factures, avoirs, encaissements, relances) **, achats** (bons de commande, factures et règlements fournisseurs, échéancier) **, trésorerie** (caisse, banque, mobile money) **, comptabilité SYSCOHADA, stocks, employés et paie ivoirienne**.

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
| Articles | Biens et services, prix de vente HT, TVA ivoirienne (18 %, 9 %, exonéré), unité, numérotation ART-, archivage |
| Devis et factures | Brouillon modifiable, puis validation avec numéro annuel sans trou (DEV-2026-00001, FAC-2026-00001), coordonnées du client figées, échéance calculée selon le délai de paiement ; devis accepté ou refusé puis transformé en facture ; ventilation de la TVA ; impression / PDF ; export CSV. Un document validé est intangible : la base de données refuse toute modification ou suppression |
| Encaissements | Paiements partiels ou complets (espèces, mobile money, virement, chèque, carte), statut payée en partie / payée, factures en retard, indicateurs du tableau de bord (chiffre d'affaires du mois, encaissé, à encaisser) |
| Avoirs | Établis depuis une facture émise (lignes reprises, à réduire pour un avoir partiel), numéro AV-2026-00001, plafonnés au montant encore créditable, diminuent le reste à payer ; facture « annulée par avoir » si entièrement couverte ; trop-perçu à rembourser signalé |
| Relances clients | Balance âgée par client (non échu, 1-30, 31-60, 61-90, plus de 90 jours), message de relance prêt à copier (WhatsApp, SMS, e-mail), historique des relances et promesses de paiement |
| Achats | Bons de commande (BC-2026-00001, imprimables, annulables) transformés en facture fournisseur ; facture saisie d'après le document reçu (référence et date du fournisseur), numéro interne ACH-2026-00001, doublon refusé (même fournisseur et même référence), échéance selon le délai du fournisseur ; règlements partiels ou complets ; échéancier (à payer sous 7 et 30 jours, retards) ; module réservé aux formules Business et supérieures |
| Trésorerie | Comptes de caisse, banque et mobile money (trois comptes créés avec chaque entreprise, solde et date d'ouverture paramétrables) ; chaque encaissement client, règlement fournisseur et remboursement de trop-perçu est inscrit automatiquement sur le compte choisi ou sur celui du mode de paiement ; dépenses et recettes courantes (loyer, CIE, SODECI, carburant, apport…), virements internes, arrêté de caisse avec enregistrement de l'écart, une page par type de compte (Caisse, Banque, Mobile money) avec son total, ses comptes et son propre journal, plus une vue d'ensemble avec le total de chaque type ; journal avec solde progressif et export CSV. Mouvements en ajout seul : une erreur se contre-passe. La caisse ne peut jamais devenir négative |
| Comptabilité SYSCOHADA | Plan comptable SYSCOHADA révisé installé par entreprise (sous-comptes ajoutables), journaux VT, AC, TR, OD, AN ; comptabilisation automatique des factures et avoirs (411 / 70x / 4431), factures fournisseurs (60x / 4452 / 401), encaissements, règlements, dépenses, virements (via 585), écarts de caisse et soldes d'ouverture (à-nouveaux contre 471) ; écritures d'OD en brouillon puis validées, contre-passation ; grand livre, balance générale, aide à la déclaration de TVA, compte de résultat, export au format du fichier des écritures comptables ; clôture de période définitive. La base garantit l'équilibre de chaque écriture, son intangibilité une fois validée et l'interdiction d'écrire dans une période clôturée |
| Stocks | Biens suivis en quantité et en valeur au coût moyen unitaire pondéré (CMUP) ; entrées par les factures fournisseurs (prix net de remise), sorties par les factures de vente, retours par les avoirs (sauf remise de prix) ; stock initial passé en à-nouveaux (311 / 471), inventaire avec écart, seuil d'alerte et ruptures, fiche de stock ; écriture de variation de stock (311 / 6031) qui corrige le résultat. Une vente au-delà du stock est refusée ; la base interdit un stock négatif et toute retouche des mouvements |
| Employés et paie | Fiches employés (contrat, CNPS, situation de famille et parts fiscales, rémunération, RIB chiffré) ; paie mensuelle : bulletins de tous les employés présents, éléments variables (heures supplémentaires, primes, absences, avances), calcul CNPS (retraite plafonnée, prestations familiales, accident du travail), CMU, ITS 2024 avec réduction pour charges de famille, taxes patronales ; validation intangible passée en comptabilité (661 / 664 / 641 contre 422 / 431 / 438 / 447 / 421), paiement des salaires depuis la trésorerie, bulletin imprimable, récapitulatif CNPS et impôts. **Taux et barèmes paramétrables, à faire valider par un expert-comptable** ; chaque paie validée garde ses paramètres. Salaires et RIB visibles seulement avec les permissions sensibles correspondantes |
| Espace employé et congés | Invitation de l'employé dans son espace (rôle « Employé », fiche rattachée à l'acceptation) ; il y consulte ses seuls bulletins validés, son solde et ses demandes de congé. Congés : 2,2 jours ouvrables acquis par mois de service (paramétrable), décompte du lundi au samedi hors dimanches et jours fériés fixes ou liés à Pâques, types (payé, maladie, maternité, permission exceptionnelle, sans solde), chevauchements et dépassements de solde refusés, validation par un responsable (jamais par soi-même) avec e-mails, planning du mois, report de solde ; congés sans solde repris comme absences dans la paie |
| Écran d'accueil | Grille des applications (une tuile et une icône par domaine : ventes, achats, trésorerie, comptabilité, stocks, paie…), limitée à ce que le rôle et la formule autorisent, avec recherche (Entrée ouvre la première) ; dans une application, pas de menu latéral : une barre du haut affiche le nom de l'application (un clic ramène à la grille) et ses pages (ex. Ventes : Devis, Factures, Avoirs, Relances clients) |
| Tableau de bord | Accessible depuis l'écran d'accueil (`/app/tableau-de-bord`). Indicateurs du mois avec évolution par rapport au mois précédent (chiffre d'affaires, encaissements, trésorerie, à encaisser, à payer), liste « À traiter » (factures en retard, factures fournisseurs échues ou à payer sous 7 jours, ruptures et seuils de stock, congés à valider, opérations non comptabilisées, vieux brouillons), graphiques sur 3, 6 ou 12 mois (chiffre d'affaires et achats, trésorerie en fin de mois), meilleurs clients et articles ; chaque section n'apparaît que selon les droits de l'utilisateur et la formule ; vue tableau, survol au clavier et mode sombre |
| E-mails | File d'envoi avec nouvelles tentatives (SMTP en production via `SMTP_URL`, mode développement sans envoi réel) ; invitations envoyées automatiquement ; mot de passe oublié (lien d'une heure, à usage unique, sans révéler si un compte existe, sessions fermées) ; devis, factures et avoirs envoyés au client avec un lien de consultation sécurisé (90 jours, sans compte) ; relances par e-mail ; page « E-mails envoyés » avec renvoi des messages en échec |
| États financiers et clôture | Bilan à toute date (présentation simplifiée du système normal SYSCOHADA : brut, amortissements, net ; tiers et trésorerie selon le sens du solde ; contrôle actif = passif), soldes significatifs de gestion (marge commerciale, valeur ajoutée, EBE, résultats d'exploitation, financier, HAO, net) ; clôture d'exercice (année civile) avec liste de contrôle (opérations non comptabilisées, brouillons, équilibre, 471, 585, stock), écriture de détermination du résultat (131 / 139), verrouillage, exercices clôturés dans l'ordre |
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

127 tests d'intégration sur une vraie base PostgreSQL (`kora_test`, recréée à chaque fichier ; PostgreSQL doit tourner, par exemple via `npm run dev:db`) : authentification, rôles et quotas, abonnements et paiements, console éditeur et support, contacts, ventes (calculs, cycle devis → facture → encaissement, avoirs, relances, intangibilité en base, droits par rôle), achats (commandes, doublons, règlements, échéancier, séparation des rôles), trésorerie (soldes, caisse jamais négative, virements, contre-passation, arrêté de caisse, remboursements, journal séparé par type de compte), comptabilité (écritures automatiques, équilibre et intangibilité en base, OD, clôture, balance, TVA, résultat, concordance trésorerie / comptabilité), stocks (CMUP, ventes refusées sans stock, retours, inventaire, variation 6031), paie (parts, barème ITS, bulletin complet, confidentialité des salaires, validation, comptabilisation, paiement), e-mails (invitation, mot de passe oublié, envoi de documents et lien public, relance, échecs et renvoi), bilan et clôture (soldes de gestion, bilan équilibré, liste de contrôle, résultat au 131, ordre des exercices), espace employé et congés (jours ouvrables ivoiriens, rattachement, confidentialité, solde, validation, reprise en paie), tableau de bord (agrégats mensuels, palmarès, alertes, sections masquées selon les droits), isolation multi-entreprises. Par sécurité, les tests refusent de s'exécuter sur une base dont le nom ne se termine pas par `_test`.

## Organisation du code

```
apps/
  api/                 API NestJS (TypeScript)
    src/common/        garde d'accès, erreurs, validation, chiffrement
    src/db/            migrations SQL versionnées, accès PostgreSQL (Kysely), contexte RLS
    src/modules/       auth, companies, rbac, billing, audit, support, platform, exports, contacts, sales, purchases, treasury, accounting, stock, payroll, leave, mail, dashboard
    test/              tests d'intégration
  web/                 interface Next.js (espace entreprise + console éditeur)
infra/db/              création des rôles et des bases PostgreSQL, PostgreSQL local (dev-postgres.mjs)
scripts/dev.mjs        lancement de tout l'environnement en une commande
.github/workflows/     intégration continue (types, tests, construction)
```

## Reste à faire

- **Phase 3 — gestion commerciale (suite)** : stocks et mouvements (réception partielle des commandes, plusieurs dépôts, transferts entre dépôts), bons de livraison, avoirs fournisseurs, rapprochement bancaire (import des relevés), facture normalisée électronique de la DGI (dès réception des spécifications), envoi des documents par e-mail.
- **Phase 4 — finance (suite)** : liasse officielle de la DSF, immobilisations et plan d'amortissement, affectation du résultat assistée, lettrage des comptes de tiers, rapprochement bancaire, paramétrage des comptes d'imputation par article.
- **Phase 5 — RH et paie (suite)** : validation des barèmes par un expert-comptable, fêtes musulmanes dans le calendrier des congés, jours de congé supplémentaires (ancienneté, mères de famille), déclarations CNPS et DISA, état 301, salariés expatriés, virements de salaires groupés.
- **Socle** : prestataire de paiement réel, e-mails des rappels d'abonnement et des bulletins de paie, téléversement du logo, verrou du cycle de facturation si plusieurs instances de l'API.

## Décisions encore ouvertes

- Prestataire de paiement réel (agrégateur mobile money + carte) : l'interface `PaymentProvider` est prête, seul le prestataire de test est branché.
- Fournisseur d'envoi des e-mails (Brevo, Mailjet, Amazon SES…) et domaine expéditeur (SPF, DKIM) : Kora est prêt, il suffit de renseigner `SMTP_URL` et `MAIL_FROM`.
- Hébergement et formalités ARTCI pour les données personnelles.
- Facture normalisée électronique de la DGI : à intégrer au module ventes (phase 3) dès réception des spécifications.
- Prix des formules : les montants de `apps/api/src/modules/billing/entitlements.ts` sont des exemples à valider.
