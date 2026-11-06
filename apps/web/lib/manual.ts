/**
 * Manuel de procédures de Kora ERP, affiché dans l'application « Manuel ».
 * Corps en Markdown simple (### sous-titres, listes, tableaux, **gras**, *italique*), rendu par components/markdown.tsx.
 * module : module de formule concerné (la section est signalée « hors formule » s'il manque) ;
 * platformOnly : réservé à l'équipe de l'éditeur.
 */
export interface ManualSection { id: string; title: string; module?: string; platformOnly?: boolean; body: string }

export const MANUAL_UPDATED = '2026-11-05';

export const MANUAL: ManualSection[] = [
  {
    id: 'objet', title: '1. Objet du manuel', body: `
Ce manuel décrit, écran par écran, comment chaque service d'une entreprise utilise Kora ERP au quotidien : qui fait quoi, dans quel ordre, et quels contrôles l'application applique. Il s'adresse aux propriétaires, gérants, comptables, commerciaux, caissiers, magasiniers, responsables RH et gestionnaires de paie.

**Comment lire une procédure.** Chaque procédure indique le rôle concerné, le chemin dans l'application (par exemple *Ventes › Factures*), puis les étapes numérotées. Les points de contrôle signalent ce que Kora bloque ou vérifie.

**Ce que vous voyez dépend de deux choses.**

- **Votre rôle** : il fixe vos droits (consulter, créer, modifier, valider, annuler, exporter, administrer). Un bouton absent signifie un droit absent.
- **La formule de l'entreprise** : un module non inclus n'apparaît pas dans le menu.

| Formule | Prix mensuel | Utilisateurs | Modules inclus |
| --- | --- | --- | --- |
| Starter | 20 000 FCFA | 5 | Contacts, ventes et stocks, caisse et mobile money |
| Business | 40 000 FCFA | 10 | Starter + achats, banque, comptabilité |
| Premium | 75 000 FCFA | 15 | Tous les modules, y compris RH, paie et évaluations (50 employés) |
| Cabinet | 150 000 FCFA | Illimité | Tous les modules, jusqu'à 10 entreprises |

Le paiement annuel équivaut à 10 mois (2 mois offerts). Chaque formule commence par 14 jours d'essai.

**Vocabulaire.**

- **Brouillon** : document modifiable, sans effet sur les comptes ni le stock.
- **Valider** : rendre un document définitif. Il reçoit son numéro et ne se modifie plus ; on le corrige par un document inverse (avoir, contre-passation).
- **Site** : un établissement de l'entreprise (boutique, agence, dépôt). Un utilisateur peut être limité à certains sites.
- **Tiers** : un client, un fournisseur, ou les deux.
`,
  },
  {
    id: 'acces', title: '2. Accès et sécurité', body: `
Chaque utilisateur a un compte personnel, protégé par un mot de passe d'au moins 10 caractères et, de préférence, par la double authentification. Un compte ne se partage jamais : toutes les actions sont tracées au nom de la personne connectée.

### 2.1 Créer son entreprise (premier accès)

*Qui : le futur propriétaire. Chemin : page de connexion › Créer mon entreprise.*

1. Saisir son nom complet, son adresse e-mail, un mot de passe et le nom de l'entreprise.
2. Valider : l'entreprise est créée avec 14 jours d'essai gratuit, sans moyen de paiement.
3. Le créateur devient **propriétaire** : il a tous les droits et invite ensuite ses collaborateurs (section 3).

Si l'équipe Kora a préparé l'entreprise pour vous, vous recevez à la place une invitation de propriétaire par e-mail.

### 2.2 Rejoindre une entreprise sur invitation

1. Ouvrir le lien reçu par e-mail. Il est valable **7 jours**.
2. Indiquer son nom complet et choisir un mot de passe, puis cliquer sur **Rejoindre l'entreprise**.
3. Si l'adresse a déjà un compte Kora, l'entreprise s'ajoute à la liste de ses entreprises.

### 2.3 Se connecter

1. Saisir l'adresse e-mail et le mot de passe, puis **Se connecter**.
2. Si la double authentification est activée, saisir le code à 6 chiffres affiché dans l'application d'authentification.
3. Choisir l'entreprise active et, si l'entreprise a plusieurs sites, le site affiché (sélecteurs en haut de l'écran).

**Points de contrôle.**

- Après **5 tentatives échouées**, le compte est bloqué **15 minutes**.
- Une session dure **12 heures** ; au-delà, il faut se reconnecter.
- Un utilisateur limité à certains sites ne voit que ceux-là.

### 2.4 Mot de passe oublié

1. Sur la page de connexion, cliquer sur **Mot de passe oublié ?** et saisir son adresse e-mail.
2. Ouvrir le lien reçu (valable **une heure** ; vérifier les courriers indésirables).
3. Choisir un nouveau mot de passe. Toutes les sessions ouvertes sont alors fermées.

Par sécurité, Kora affiche le même message que l'adresse existe ou non.

### 2.5 Activer la double authentification

*Chemin : Ma sécurité.* Recommandée pour le propriétaire, le comptable et le gestionnaire de paie.

1. Installer sur son téléphone une application d'authentification (Google Authenticator, Microsoft Authenticator…).
2. Dans *Ma sécurité › Double authentification*, cliquer sur **Configurer**.
3. Ajouter un compte dans l'application avec la clé affichée.
4. Saisir le code à 6 chiffres affiché par l'application, puis **Activer**.

### 2.6 Changer son mot de passe et fermer ses sessions

*Chemin : Ma sécurité.*

- **Mot de passe** : saisir l'actuel puis le nouveau, et cliquer sur **Changer le mot de passe**.
- **Sessions ouvertes** : la liste montre chaque appareil connecté. Cliquer sur **Fermer** pour déconnecter un appareil perdu ou inconnu.
`,
  },
  {
    id: 'administration', title: "3. Administration de l'entreprise", body: `
L'administration revient au propriétaire, ou à un utilisateur qui a le droit « Gérer les utilisateurs » ou « Modifier les paramètres ». Ces écrans sont disponibles dans toutes les formules.

### 3.1 Renseigner la fiche entreprise

*Chemin : Entreprise.*

1. Dans **Logo**, cliquer sur **Ajouter le logo** et choisir l'image (PNG à fond transparent de préférence). Il est enregistré aussitôt.
2. Compléter la raison sociale, la forme juridique, le NCC, le régime fiscal, l'adresse, le téléphone et l'e-mail de contact.
3. Cliquer sur **Enregistrer**.

Le logo et ces informations figurent sur les devis, factures et bulletins. Les informations fiscales (NCC, régime) ne se modifient qu'avec la permission sensible « paramètres fiscaux ». Chaque modification est inscrite au journal d'audit.

### 3.2 Créer et gérer les sites

*Chemin : Sites et magasins › Sites.*

1. Cliquer sur **Nouveau site**, saisir le nom, la ville, l'adresse et le téléphone. Laisser le code vide pour qu'il soit attribué automatiquement.
2. Enregistrer. Un entrepôt « Dépôt *nom du site* » est créé avec le site.
3. Ajouter si besoin d'autres entrepôts (Stocks) et des comptes de caisse, banque ou mobile money (Trésorerie), en choisissant le site dans l'en-tête.

- **Site principal** : désigne le site proposé par défaut.
- **Archiver** : retire un site fermé sans effacer son historique. Le site principal ne s'archive pas.
- **Comparatif des sites** : chiffre d'affaires, encaissements, trésorerie, stock et résultat par site et par période.

### 3.3 Inviter un collaborateur

*Chemin : Utilisateurs.*

1. Cliquer sur **Inviter un collaborateur**.
2. Saisir l'adresse e-mail, choisir le rôle et, si nécessaire, le site auquel limiter la personne.
3. Cliquer sur **Inviter**. L'invitation part par e-mail et reste valable 7 jours ; elle apparaît dans *Invitations en attente* jusqu'à son acceptation.

Le nombre d'utilisateurs est limité par la formule (5 en Starter, 10 en Business, 15 en Premium).

### 3.4 Modifier ou retirer un accès

*Chemin : Utilisateurs › Modifier.*

- **Rôles** : cocher un ou plusieurs rôles.
- **Sites visibles** : *Tous les sites* ou *Seulement* certains. Un utilisateur limité ne voit et ne saisit que les ventes, achats, stocks, caisses et employés de ses sites, et ne prépare pas la paie.
- **Accès jusqu'au** : date de fin, pour un auditeur ou un consultant.
- **Statut** : *Désactivé* coupe l'accès immédiatement, sans supprimer l'historique de la personne.

Au départ d'un collaborateur, désactiver son accès le jour même.

**Points de contrôle.**

- Personne ne peut modifier ses propres rôles ni désactiver son propre accès.
- L'entreprise garde toujours au moins un propriétaire actif, et seul un propriétaire modifie l'accès d'un autre propriétaire.
- Un utilisateur limité à certains sites ne peut donner accès qu'à ses propres sites.

### 3.5 Adapter les rôles

*Chemin : Rôles.*

Kora fournit 11 rôles standard (annexe A). Pour un besoin particulier :

1. Cliquer sur **Nouveau rôle**, ou **Modifier** sur un rôle existant.
2. Cocher les permissions module par module. Les modules hors formule sont signalés « hors formule ».
3. Enregistrer.

Le rôle Propriétaire ne se modifie pas. Les rôles standard se modifient mais ne se suppriment pas. Un rôle encore attribué ne se supprime pas. Seul un propriétaire attribue les **permissions sensibles** : voir tous les salaires, les coordonnées bancaires des employés, les paramètres fiscaux, la clôture comptable, la contre-passation et l'export intégral des données.

### 3.6 Contrôler avec le journal d'audit

*Chemin : Journal d'audit.*

Le journal liste toutes les actions sensibles (créations, validations, annulations, exports, changements de droits), y compris celles de l'éditeur Kora et de son support. Il indique la date, l'auteur, l'action et le détail. Personne ne peut le modifier.

Contrôle conseillé : le propriétaire le parcourt une fois par mois (annexe C).

### 3.7 Exporter toutes les données

*Chemin : Entreprise › Exporter toutes les données (.zip).* Réservé à la permission sensible « export intégral ». À faire avant toute résiliation et, par prudence, une fois par trimestre.
`,
  },
  {
    id: 'contacts', title: '4. Contacts (clients et fournisseurs)', module: 'contacts', body: `
Tout document de vente ou d'achat s'appuie sur un contact. La fiche doit donc être complète avant la première facture : Kora refuse d'enregistrer une fiche incomplète.

### 4.1 Créer un contact

*Qui : commercial, comptable, propriétaire. Chemin : Contacts › Nouveau contact.*

1. Choisir le **type de tiers** : Client, Fournisseur, ou Client et fournisseur.
2. Choisir la **forme** : Entreprise ou Particulier.
3. Remplir les champs marqués d'un astérisque (tableau ci-dessous), puis les autres informations utiles : adresse, ville, pays, logo ou photo.
4. Cliquer sur **Enregistrer**. Le code est attribué à ce moment-là.

| Forme | Champs obligatoires |
| --- | --- |
| Entreprise | Raison sociale, téléphone, e-mail, NCC, RCCM, délai de paiement (en jours, 0 = comptant) |
| Particulier | Nom et prénoms, téléphone |

### 4.2 Le code du contact

Le code n'est jamais saisi : Kora le génère selon le type de tiers et l'affiche avant l'enregistrement.

| Type de tiers | Préfixe | Exemple |
| --- | --- | --- |
| Client | CLI | CLI-00001 |
| Fournisseur | FRS | FRS-00001 |
| Client et fournisseur | TIE | TIE-00001 |

Si l'on change le type de tiers d'un contact, il reçoit un nouveau code avec le bon préfixe. Les documents déjà émis gardent l'ancien.

### 4.3 Modifier, archiver, restaurer

- **Modifier** : ouvrir la fiche, corriger, enregistrer. Une fiche créée avant les règles actuelles doit être complétée à sa prochaine modification.
- **Archiver** : un contact ne se supprime pas, il s'archive. Il disparaît des listes et des choix, mais son historique reste. Un contact archivé ne se modifie pas.
- **Restaurer** : filtre *Archivés*, puis **Restaurer**.

### 4.4 Suivre et exporter

- La fiche affiche, pour un client, les factures émises et le montant restant à encaisser ; pour un fournisseur, les factures reçues et le montant restant à payer.
- **Planifier un rendez-vous** depuis la fiche crée un événement dans le calendrier.
- **Exporter (CSV)** produit la liste filtrée, avec la permission « Contacts : exporter ». L'export est tracé au journal d'audit.
`,
  },
  {
    id: 'stocks', title: '5. Articles et stocks', module: 'sales', body: `
Les ventes et les achats facturés mettent le stock à jour automatiquement. Le magasinier n'intervient que pour ce qui n'est pas facturé : stock initial, achats comptant, casse, transferts et inventaires. Le stock est valorisé au coût moyen pondéré (CMUP).

### 5.1 Créer un article

*Chemin : Articles › Nouvel article.*

1. Choisir le type : **Bien (marchandise)**, suivi en stock, ou **Service**, jamais stocké.
2. Saisir la désignation, le prix de vente HT, le taux de TVA (0 % si exonéré) et, si connu, le prix d'achat HT. Le code (ART-00001, ART-00002…) est attribué automatiquement à l'enregistrement et ne se modifie pas.
3. Pour un bien, indiquer le **seuil d'alerte** : en dessous, Kora propose de commander.
4. Enregistrer.

Un article ne se supprime pas : il s'archive.

### 5.2 Saisir le stock initial

*Chemin : Stocks › Stock initial (sur la ligne de l'article).* À faire une seule fois, au démarrage.

1. Saisir la quantité présente avant l'utilisation de Kora et son coût d'achat unitaire HT.
2. Valider. La valeur est passée en comptabilité en à-nouveaux (311000 / 471000).

Un article qui a déjà des mouvements ne reçoit plus de stock initial : on le corrige par un inventaire.

### 5.3 Gérer les entrepôts

*Chemin : Stocks › Entrepôts.* Un entrepôt peut être un dépôt, une boutique ou un véhicule de livraison. Chaque vente sort de l'entrepôt choisi sur la facture, chaque achat entre dans celui choisi sur la facture fournisseur ; à défaut, c'est l'entrepôt principal du site.

Pour archiver un entrepôt, il doit être vide (transférer d'abord la marchandise), sans bon en brouillon, et ne pas être l'entrepôt par défaut.

### 5.4 Passer une entrée, une sortie ou un transfert

*Qui : magasinier. Chemin : Stocks › Entrées et sorties › + Entrée, − Sortie ou ⇄ Transfert.*

1. Choisir l'entrepôt (de départ et d'arrivée pour un transfert) et le **motif**.
2. Ajouter les articles et les quantités, une ligne par article.
3. Enregistrer en brouillon, imprimer le bon si besoin pour signature (livré par, reçu par, visa du responsable).
4. **Valider** : le stock bouge à ce moment-là.

| Bon | Motifs possibles |
| --- | --- |
| Entrée | Achat comptant, production, retour hors facture, don reçu, marchandise retrouvée, autre |
| Sortie | Consommation interne, casse ou perte, vol, produit périmé, don, échantillon gratuit, autre |
| Transfert | Déplacement d'un entrepôt à un autre |

**Achat comptant** : indiquer le prix payé de chaque article et le compte (caisse, banque ou mobile money) qui a payé. À la validation, Kora enregistre l'entrée en stock, la sortie d'argent et l'écriture D 601000 / C trésorerie. Un achat avec facture passe par le module Achats.

**Points de contrôle.**

- Kora refuse une sortie ou un transfert supérieur au stock disponible de l'entrepôt.
- La date d'un bon ne peut pas être dans le futur.
- Un bon validé ne se modifie ni ne se supprime : on passe un bon inverse ou un inventaire.

### 5.5 Faire un inventaire

*Chemin : Stocks › Inventaires › Nouvel inventaire.* Conseillé au moins une fois par an, à la clôture, et chaque mois pour les articles de valeur.

1. Choisir l'entrepôt : l'inventaire reprend tous ses articles suivis.
2. **Imprimer la feuille de comptage** et compter physiquement.
3. Saisir les quantités comptées (en plusieurs fois si besoin) et, pour chaque écart, sa raison (casse, erreur de livraison…).
4. **Valider** : chaque écart entre ou sort au coût moyen, et la variation suit en comptabilité.

### 5.6 Suivre le stock et réapprovisionner

- **Stocks** affiche par article le stock physique, le réservé (par des commandes clients), le disponible, le prévisionnel et le seuil. Disponible = physique − réservé ; prévisionnel = disponible + à recevoir.
- Filtre **À commander** : sélectionner les articles, choisir le fournisseur, puis **Préparer le bon de commande**. La quantité proposée remonte le stock à deux fois le seuil.
- **Mouvements** : historique filtrable et exportable en CSV, chaque ligne renvoyant à sa pièce.

### 5.7 Valoriser le stock à la clôture

*Qui : comptable. Chemin : Stocks › Valorisation.*

Les achats de marchandises sont passés en charges (601). À chaque clôture, mensuelle ou annuelle :

1. Choisir la date de clôture et vérifier la valeur du stock par article.
2. Cliquer sur **Comptabiliser la variation**. Kora ajuste le compte 311000 à la valeur réelle (D 311 / C 6031 si le stock a augmenté, l'inverse sinon).

Si le compte 311000 est déjà égal à la valeur du stock, aucune écriture n'est nécessaire.
`,
  },
  {
    id: 'ventes', title: '6. Ventes', module: 'sales', body: `
Une vente suit le circuit devis → bon de commande → facture → encaissement ; chaque étape peut être sautée (facturer directement un devis, ou créer une facture sans devis). Seule la facture émise a un effet comptable et sort la marchandise du stock. Une facture émise se corrige par un avoir, jamais en l'effaçant.

### 6.1 Établir un devis

*Qui : commercial. Chemin : Ventes › Devis › Nouveau devis.*

1. Choisir le client (il doit être enregistré comme client ou client et fournisseur).
2. Ajouter les lignes : un article du catalogue, ou une saisie libre. Vérifier quantités, prix HT et TVA.
3. Indiquer la date de validité (vide : 30 jours), puis **Enregistrer le brouillon**.
4. **Valider le devis** : il reçoit son numéro et ne se modifie plus.
5. L'envoyer (**Envoyer par e-mail** ou **Imprimer / PDF**), puis noter la réponse : **Accepté par le client** ou **Refusé par le client**.

### 6.2 Confirmer la commande

*Chemin : depuis le devis, Transformer en bon de commande.*

1. Reporter la référence de commande du client et la date de livraison prévue.
2. **Confirmer la commande** : elle reçoit son numéro, réserve la marchandise en stock et passe « à facturer ».

Une commande confirmée et non facturée peut être annulée (**Annuler la commande**) ; un brouillon se supprime.

### 6.3 Émettre la facture

*Qui : commercial pour préparer, utilisateur ayant le droit « Ventes : valider » pour émettre. Chemin : Transformer en facture (depuis la commande), Facturer directement (depuis le devis) ou Ventes › Factures › Nouvelle facture.*

1. Vérifier le client, les lignes, l'entrepôt de livraison et l'échéance (calculée d'après le délai de paiement du client).
2. **Enregistrer le brouillon**, puis **Émettre la facture**.
3. La facture reçoit son numéro définitif (FAC-année-numéro, sans trou), la marchandise sort du stock et l'écriture de vente est passée en comptabilité.
4. Envoyer la facture : **Envoyer par e-mail** (le client reçoit un lien sécurisé valable 90 jours, sans créer de compte) ou **Imprimer / PDF**.

**Corriger une facture émise.**

- Tant qu'elle n'a reçu ni encaissement ni avoir, un utilisateur habilité peut la **remettre en brouillon** : l'écriture est contre-passée et la marchandise rentre en stock. Elle garde son numéro ; on la corrige puis on l'émet de nouveau.
- Sinon, on établit un avoir (6.5).

Une facture qui a reçu son numéro ne se supprime jamais, pour garder une numérotation continue.

### 6.4 Enregistrer un encaissement

*Qui : caissier, comptable. Chemin : la facture › Enregistrer un encaissement.*

1. Saisir le montant, la date, le mode de paiement et le compte qui reçoit l'argent (caisse, mobile money, banque).
2. Noter la référence (numéro de transaction, de chèque, de virement).
3. Valider. La facture passe « Partiellement réglée » ou « Payée ».

Le montant ne peut dépasser le reste à payer, et la date ne peut être dans le futur. Virement, chèque et carte ne sont proposés que si la formule inclut le module Banque. Si le client a trop payé (après un avoir), **Rembourser le client** enregistre la sortie d'argent.

### 6.5 Établir un avoir

*Chemin : la facture › Établir un avoir.*

1. L'avoir reprend la facture : pour un avoir partiel, réduire les quantités ou les prix.
2. Indiquer le motif, puis **Émettre l'avoir**.
3. L'avoir diminue le reste à payer de la facture et fait rentrer la marchandise retournée.

Un avoir ne peut dépasser le montant encore créditable de la facture. Pour annuler entièrement une facture, établir un avoir du montant total.

### 6.6 Relancer les impayés

*Qui : commercial, comptable. Chemin : Ventes › Relances clients.*

L'écran classe les factures non soldées par ancienneté : non échu, 1 à 30 jours, 31 à 60, 61 à 90, plus de 90 jours.

1. Cliquer sur **Relancer** sur la facture.
2. Choisir le canal : e-mail (envoyé par Kora), ou téléphone, WhatsApp, SMS (**Copier le message** pour le coller).
3. Noter le compte rendu et, le cas échéant, la date de paiement promise.

Chaque relance est inscrite dans l'historique de la facture. Rythme conseillé : une relance à l'échéance, puis toutes les deux semaines.
`,
  },
  {
    id: 'achats', title: '7. Achats', module: 'purchases', body: `
Un achat avec facture suit le circuit bon de commande → facture fournisseur → règlement. La facture fournisseur validée fait entrer la marchandise en stock et passe l'écriture d'achat. Le module Achats est inclus à partir de la formule Business ; un achat payé comptant sans facture passe par un bon d'entrée (5.4).

### 7.1 Commander au fournisseur

*Qui : comptable, magasinier (consultation). Chemin : Achats › Bons de commande › Nouveau bon de commande, ou Stocks › À commander.*

1. Choisir le fournisseur (enregistré comme fournisseur ou client et fournisseur).
2. Ajouter les articles, quantités et prix d'achat HT ; indiquer la date de livraison prévue.
3. **Enregistrer le brouillon**, puis **Valider le bon de commande** : il reçoit son numéro.
4. L'envoyer au fournisseur (**Imprimer / PDF**).

Un bon de commande envoyé et non facturé peut être annulé (**Annuler la commande**).

### 7.2 Enregistrer la facture du fournisseur

*Chemin : le bon de commande › Saisir la facture reçue, ou Achats › Factures fournisseurs › Nouvelle facture fournisseur.*

1. Recopier la facture reçue : numéro de facture du fournisseur (obligatoire), date, lignes et montants.
2. Choisir l'entrepôt de réception.
3. Comparer avec le bon de livraison : quantités reçues et prix facturés.
4. **Valider la facture** : la marchandise entre en stock au prix facturé et l'écriture d'achat est passée.

**Points de contrôle.**

- Kora refuse d'enregistrer deux fois la même facture d'un fournisseur (même numéro).
- La date ne peut pas être dans le futur.
- Une facture validée sans règlement peut être **remise en brouillon** pour correction ; elle garde son numéro. Après un règlement, elle ne se modifie plus.

### 7.3 Payer le fournisseur

*Qui : comptable, responsable financier. Chemin : la facture › Enregistrer un règlement.*

1. Consulter **Achats › Échéancier** : il classe les factures à payer par échéance (à échoir, puis 1 à 30, 31 à 60, 61 à 90 et plus de 90 jours de retard).
2. Sur la facture à payer, saisir le montant, la date, le compte qui paie (caisse, banque, mobile money) et la référence (numéro de virement, de chèque).
3. Valider. La sortie d'argent et l'écriture de règlement sont enregistrées.

Le montant ne peut dépasser le reste à payer. Contrôle conseillé : revoir l'échéancier chaque semaine pour préparer les paiements.
`,
  },
  {
    id: 'tresorerie', title: '8. Trésorerie et banque', module: 'cash', body: `
Chaque somme d'argent de l'entreprise est suivie dans un compte de trésorerie : caisse, compte bancaire ou compte mobile money. Les encaissements clients, règlements fournisseurs et paiements de salaires y arrivent automatiquement ; on ne saisit ici que les autres recettes et dépenses. Les comptes bancaires (virement, chèque, carte) nécessitent le module Banque, inclus à partir de Business.

### 8.1 Ouvrir un compte de trésorerie

*Qui : propriétaire, comptable. Chemin : Trésorerie › Caisse, Banque ou Mobile money › Nouveau compte.*

1. Choisir le site dans l'en-tête (sinon le compte est rattaché au site principal).
2. Saisir le nom du compte (ex. « Caisse boutique », « SGCI », « Orange Money »), puis la banque et le RIB, ou l'opérateur et le numéro marchand.
3. Saisir le **solde d'ouverture** et sa **date** : le montant réellement présent à cette date, avant tout mouvement saisi dans Kora.
4. Enregistrer.

Un solde d'ouverture faux fausse tous les soldes suivants. Si un compte affiche un solde négatif, le corriger par **Paramétrer**.

### 8.2 Saisir une dépense ou une recette

*Qui : caissier, comptable. Chemin : Trésorerie › Dépense ou Recette.*

1. Choisir la catégorie, le compte (payé depuis / encaissé sur), le montant et la date.
2. Ajouter un libellé et la référence de la pièce (numéro de reçu, de facture CIE…). Conserver la pièce justificative.
3. Enregistrer : l'écriture comptable est passée automatiquement.

| Type | Catégories |
| --- | --- |
| Dépense | Loyer, électricité (CIE), eau (SODECI), carburant, transport, téléphone et internet, fournitures, entretien, salaires et avances, impôts et taxes, frais bancaires, retrait de l'exploitant, autre |
| Recette | Apport (capital, exploitant), emprunt reçu, autre recette |

**Points de contrôle.** Une caisse ne peut pas sortir plus d'espèces qu'elle n'en contient. La date ne peut pas être dans le futur ni antérieure à l'ouverture du compte.

### 8.3 Virement entre comptes

*Chemin : Trésorerie › Virement interne.* Pour déposer les recettes de la caisse à la banque, alimenter la caisse par un retrait, ou transférer vers le mobile money.

1. Choisir le compte de départ et le compte d'arrivée (différents), le montant et la date.
2. Noter la référence (bordereau de versement, reçu de retrait).
3. Enregistrer : les deux comptes sont mis à jour en même temps.

### 8.4 Faire l'arrêté de caisse

*Qui : caissier, sous le contrôle d'un responsable ayant le droit « Caisse : valider ». Chemin : Trésorerie › Arrêté (sur la ligne de la caisse).* À faire chaque soir de fermeture.

1. Compter les espèces présentes dans la caisse.
2. Saisir le montant compté. Kora le compare au solde théorique.
3. En cas d'écart, en indiquer la raison (ex. erreur de rendu de monnaie). L'écart est enregistré et le solde de la caisse ajusté.

Un écart répété doit être signalé au responsable.

### 8.5 Corriger un mouvement

*Chemin : Trésorerie › Journal › Contre-passer.*

Un mouvement saisi par erreur ne s'efface pas : on le **contre-passe**. Kora crée le mouvement inverse ; l'original reste visible, marqué « Contre-passé », puis on ressaisit le bon mouvement.

Les mouvements issus d'une facture ou d'un arrêté de caisse ne se contre-passent pas ici : on corrige le document d'origine (avoir, nouvel arrêté).

### 8.6 Rapprocher la banque et le mobile money

*Qui : comptable. Fréquence : chaque mois, à réception du relevé.*

1. Ouvrir le **Journal de trésorerie** filtré sur le compte et le mois, ou l'exporter en CSV.
2. Pointer chaque ligne avec le relevé bancaire ou l'historique de l'opérateur.
3. Saisir les mouvements manquants (frais bancaires, agios, commissions) et contre-passer les erreurs.
4. Vérifier que le solde de Kora égale celui du relevé à la même date.

### 8.7 Archiver un compte

Un compte fermé s'archive par **Paramétrer › Archiver ce compte**, après avoir viré son solde vers un autre compte : Kora refuse d'archiver un compte non vide.
`,
  },
  {
    id: 'comptabilite', title: '9. Comptabilité', module: 'accounting', body: `
La comptabilité se tient d'elle-même : factures, avoirs, règlements, mouvements de trésorerie, stock et paie sont comptabilisés automatiquement selon le plan SYSCOHADA révisé. Le comptable saisit seulement les opérations diverses, contrôle, déclare la TVA et clôture. Module inclus à partir de la formule Business.

### 9.1 Passer une écriture d'opérations diverses

*Qui : comptable. Chemin : Comptabilité › Nouvelle écriture.* Pour les reclassements, amortissements, provisions, affectation du résultat.

1. Choisir le journal : **OD** (opérations diverses) ou **AN** (à-nouveaux, pour la reprise d'un bilan d'ouverture).
2. Saisir la date, le libellé et la pièce justificative.
3. Saisir les lignes : compte, libellé, débit ou crédit.
4. **Enregistrer en brouillon** pour la faire relire, ou **Enregistrer et valider**.

Kora refuse de valider une écriture déséquilibrée (elle peut rester en brouillon). Les autres journaux (VT ventes, AC achats, TR trésorerie) sont réservés aux écritures automatiques.

### 9.2 Corriger une écriture

- **Brouillon** : se modifie ou se supprime librement.
- **Écriture validée** : ne se modifie ni ne se supprime. **Contre-passer** crée une écriture inverse à la date du jour ; l'original reste au journal. Droit sensible, réservé au comptable et au propriétaire.
- **Écriture issue d'un document** (facture, règlement) : on corrige le document lui-même (avoir, contre-passation en trésorerie).

### 9.3 Compléter le plan comptable

*Chemin : Comptabilité › Plan comptable › Nouveau sous-compte.* Un sous-compte se crée toujours sous un compte SYSCOHADA existant (ex. 601100 sous 601000). Les comptes de caisse, banque et mobile money sont créés automatiquement avec les comptes de trésorerie.

### 9.4 Déclarer la TVA

*Qui : comptable. Fréquence : chaque mois.*

1. Ouvrir l'état **Déclaration de TVA** et choisir le mois.
2. Relever la TVA facturée, la TVA récupérable (445…) et la TVA nette à payer, ou le crédit à reporter.
3. Reporter ces montants sur la déclaration mensuelle de la DGI (e-impôts). Un crédit de TVA se reporte sur le mois suivant.

L'état ne reprend que les écritures validées : valider les brouillons du mois avant de déclarer.

### 9.5 Consulter les états

| État | Usage |
| --- | --- |
| Journal des écritures | Liste des écritures par journal et par statut |
| Grand livre | Détail d'un compte avec solde progressif ; grand livre des clients et des fournisseurs |
| Balance générale | Contrôle de l'équilibre débit = crédit |
| Compte de résultat | Produits, charges et résultat de la période |
| Bilan | Actif et passif à une date (présentation simplifiée SYSCOHADA) |
| Soldes de gestion | Marge commerciale, valeur ajoutée, EBE |

Chaque état s'imprime ou s'exporte en PDF ; **Exporter les écritures** fournit le fichier pour l'expert-comptable. Les états officiels (DSF) restent établis par l'expert-comptable.

### 9.6 Clôturer une période

*Qui : comptable ou propriétaire (droit sensible « clôturer »). Chemin : Comptabilité › Clôturer une période.* Conseillé chaque mois, après la déclaration de TVA.

1. Valider ou supprimer les écritures en brouillon de la période.
2. Lancer la comptabilisation des opérations en attente, s'il y en a.
3. Indiquer la date « Clôturer jusqu'au (inclus) », puis confirmer.

**Une clôture est définitive** : plus aucune écriture ne peut être passée à cette date ou avant, y compris par les factures et la trésorerie.

### 9.7 Clôturer l'exercice

*Chemin : Comptabilité › Clôture d'exercice.* Après le 31 décembre, une fois les écritures d'inventaire passées.

1. Passer les écritures d'inventaire : variation de stock (5.7), amortissements, provisions.
2. Lire la liste de contrôle. Les points bloquants doivent être réglés : exercice non terminé, exercice précédent non clôturé, opérations non comptabilisées, brouillons, balance déséquilibrée.
3. Examiner les avertissements avec l'expert-comptable : compte d'attente 471 non soldé, virements internes 585 non soldés, compte de stock différent de la valeur du stock.
4. Clôturer. Les comptes de charges et de produits sont soldés dans le résultat (131000 bénéfice ou 139000 perte), puis l'exercice est verrouillé.
5. Après l'assemblée qui approuve les comptes, passer l'affectation du résultat par une écriture d'OD (ex. vers 111000 réserve légale, 121000 report à nouveau ou 465000 dividendes).

Les exercices se clôturent dans l'ordre, et une clôture ne se défait pas.
`,
  },
  {
    id: 'rh', title: '10. Ressources humaines', module: 'hr', body: `
La fiche employé est la base des congés, des évaluations et de la paie. Ces modules sont inclus dans les formules Premium et Cabinet. Les salaires ne sont visibles qu'avec la permission sensible « voir les salaires et bulletins ».

### 10.1 Créer la fiche d'un employé

*Qui : responsable RH ; la rémunération par le gestionnaire de paie. Chemin : Employés › Nouvel employé.*

1. **Identité** : nom, prénom, photo, téléphone, e-mail (nécessaire pour l'espace employé), situation familiale, enfants à charge. Les parts fiscales se calculent automatiquement si le champ reste vide.
2. **Emploi** : site, service, poste, catégorie, type de contrat (CDI, CDD, stage, journalier), date d'embauche, numéro CNPS.
3. **Rémunération** : salaire de base (salaire catégoriel), sursalaire, indemnités de transport, de logement et autres. Pour partir d'un net convenu, saisir le net à payer puis **Calculer la fiche** : Kora déduit le sursalaire compte tenu de la CNPS, de la CMU et de l'ITS.
4. **Paiement** : mode de paiement du salaire, numéro mobile money ou coordonnées bancaires (permission sensible).
5. Enregistrer. Le bulletin simulé affiché permet de vérifier brut et net.

Au départ d'un employé, renseigner sa **date de sortie** puis établir son solde de tout compte (11.5). Sa fiche reste consultable.

### 10.2 Ouvrir l'espace employé

*Chemin : Employés › la fiche › Inviter dans son espace.* L'employé reçoit une invitation par e-mail. Depuis son espace (section 12), il consulte ses bulletins et ses évaluations approuvées, et demande ses congés.

### 10.3 Gérer les congés et absences

*Qui : responsable RH ou directeur pour valider. Chemin : Congés.*

Chaque employé acquiert 2,2 jours ouvrables de congé payé par mois de service. Les dimanches et jours fériés ne sont pas décomptés.

**Au démarrage**, pour chaque employé : saisir le **report** (jours encore dus à la mise en service de Kora) et la date de début d'acquisition (vide : date d'embauche).

**Pour une absence :**

1. L'employé demande depuis son espace, ou le RH clique sur **Saisir une absence** : employé, type, dates du… au… (inclus), motif.
2. La demande est créée « En attente » et apparaît dans **Demandes à traiter**.
3. Le responsable **Valide** ou **Refuse**. Personne ne valide sa propre demande.

Types : congé payé, maladie, maternité, permission exceptionnelle, congé sans solde, autre absence. Un congé sans solde validé est déduit dans la paie du mois.

**Points de contrôle.** Kora refuse un congé payé supérieur au solde disponible (demandes en attente déduites) et deux demandes qui se chevauchent. Les fêtes musulmanes (Ramadan, Tabaski, Maouloud, Nuit du destin) dépendent de l'annonce officielle : elles ne sont pas comptées automatiquement.

### 10.4 Conduire une campagne d'évaluation

*Qui : responsable RH (campagne), évaluateurs (fiches), une personne qui voit les salaires (décision). Chemin : Évaluations.*

1. **Lancer** : *Nouvelle campagne* : intitulé (ex. évaluation annuelle, fin de période d'essai), période évaluée, date de remise, évaluateur, critères notés de 1 à 5 avec leur coefficient, employés évalués. Puis **Lancer la campagne** ; l'évaluateur reçoit un e-mail.
2. **Remplir** (évaluateur) : noter chaque critère, rédiger les points forts, axes de progrès, objectifs et le commentaire général. Proposer, si justifié, une prime et/ou une augmentation en pourcentage. **Soumettre** (tous les critères doivent être notés).
3. **Décider** (personne qui voit les salaires) : fixer les montants, choisir le mois de versement de la prime et le mois d'effet de l'augmentation, puis **Approuver** ou **Refuser**.
4. **Effets** : la prime est ajoutée au bulletin du mois choisi ; l'augmentation devient le salaire de base à partir de son mois d'effet. L'employé est prévenu par e-mail s'il a un espace.
5. **Clore** la campagne une fois toutes les évaluations traitées. Elle peut être rouverte.

Personne ne remplit ni ne décide de sa propre évaluation. Une prime ne peut viser qu'un mois de paie encore ouvert.
`,
  },
  {
    id: 'paie', title: '11. Paie', module: 'payroll', body: `
La paie se prépare une fois par mois pour toute l'entreprise, d'après les fiches employés, les absences validées et les primes approuvées. Elle est réservée au gestionnaire de paie (ou au propriétaire), qui doit avoir la permission sensible « voir les salaires et bulletins » et accès à tous les sites. Module inclus dans les formules Premium et Cabinet.

### 11.1 Paramétrer la paie (une fois, puis à chaque changement légal)

*Chemin : Paie › Paramètres.*

1. Vérifier les taux et plafonds : CNPS retraite (parts salariale et patronale, plafond), prestations familiales, accident du travail, CMU, contribution employeur, taxe de formation continue, transport exonéré, SMIG, jours de référence, congés acquis par mois.
2. Compléter la **grille des catégories** : salaire catégoriel mensuel de chaque catégorie selon la convention collective de la branche.
3. Vérifier le barème de l'ITS et la réduction pour charges de famille.
4. Enregistrer.

Ces valeurs sont à faire valider par l'expert-comptable. Une modification s'applique aux paies préparées ou recalculées ensuite, jamais aux paies validées.

### 11.2 Contrôler les contrats avant la paie

*Chemin : Paie › Contrats.* L'écran signale les fiches à corriger avant de préparer la paie : contrat qui se termine dans les 30 jours, CDD sans date de fin, salaire sous le SMIG, employé sans catégorie, sans numéro CNPS ou sans coordonnées de paiement. Les corrections se font sur la fiche employé.

### 11.3 Préparer, contrôler et valider la paie du mois

*Chemin : Paie › Bulletins › Préparer la paie.*

1. Vérifier dans **Paie › Temps et absences** que les congés et absences du mois sont validés.
2. **Préparer la paie** du mois : Kora crée un bulletin brouillon par salarié présent. On ne prépare pas un mois futur.
3. Saisir les **éléments variables** de chaque bulletin : heures supplémentaires, primes du mois, jours d'absence non rémunérés, autres retenues.
4. Contrôler les bulletins et les totaux : net à payer, coût employeur, montants à déclarer à la CNPS et aux impôts.
5. **Valider la paie** : les bulletins ne se modifient plus et l'écriture de paie est passée en comptabilité.

Une paie validée peut être **remise en brouillon** tant qu'aucun salaire n'est payé. Kora refuse un net à payer négatif.

### 11.4 Payer les salaires et déclarer

1. Sur la paie validée, cliquer sur **Payer les salaires** : choisir le compte (banque, mobile money, caisse) et la date. Kora enregistre un décaissement par salarié non encore payé.
2. Remettre ou envoyer les bulletins (**Imprimer / PDF**). Les salariés qui ont un espace les y retrouvent.
3. Reporter les totaux « À déclarer à la CNPS » (retraite, prestations familiales, accident du travail, CMU) et « À déclarer aux impôts » (ITS, taxes) sur les déclarations mensuelles, puis enregistrer leur paiement en trésorerie (catégorie Impôts et taxes).

**Paie › Masse salariale** présente par mois le net versé, les cotisations, impôts et taxes, et le coût employeur.

### 11.5 Établir le solde de tout compte

*Chemin : Paie › Départs.*

1. Choisir l'employé, le motif de départ (licenciement, démission, fin de CDD, rupture d'un commun accord, retraite, faute lourde) et la date de fin du contrat.
2. Indiquer le préavis non effectué payé par l'employeur et les jours de congés à indemniser (proposés d'après le module Congés).
3. **Calculer le solde**, faire valider le calcul par l'expert-comptable, puis imprimer le **reçu pour solde de tout compte** à signer par les deux parties.
4. Remettre aussi le certificat de travail et l'attestation CNPS.

Le calcul est indicatif, selon le Code du travail ivoirien. Le salaire du dernier mois est payé par la paie du mois.
`,
  },
  {
    id: 'espace', title: '12. Espace personnel, calendrier, e-mails et support', body: `
### 12.1 L'espace de l'employé

*Qui : tout salarié invité depuis sa fiche (10.2). Chemin : Mon espace.*

- **Demander un congé** : choisir le type et les dates (du… au… inclus) ; le solde disponible s'affiche. La demande attend la validation du responsable. Elle peut être annulée tant qu'elle est en attente.
- **Mes bulletins de paie** : consulter et imprimer chaque bulletin, avec sa date de paiement.
- **Mes évaluations** : points forts, axes de progrès, prime et nouveau salaire de base, une fois l'évaluation approuvée.

### 12.2 Planifier un rendez-vous

*Chemin : Calendrier › Nouveau rendez-vous, ou depuis une fiche contact.*

1. Cliquer sur un jour ou une heure, ou sur **Nouveau rendez-vous**.
2. Saisir l'objet, le type (réunion…), les horaires, le contact concerné, les participants et un rappel (10 minutes à la veille).
3. Enregistrer. Chaque participant reçoit un e-mail à l'invitation, au déplacement et à l'annulation.

Pour prévenir les participants d'un rendez-vous annulé, utiliser **Annuler le rendez-vous** plutôt que *Supprimer*. **Marquer fait** clôt un rendez-vous tenu.

### 12.3 Suivre les e-mails envoyés

*Chemin : E-mails.* Kora envoie les invitations, factures, relances et rappels depuis une file d'envoi. L'écran liste chaque message avec son destinataire, son objet et son statut (envoyé, en attente, en échec). Kora réessaie automatiquement ; un message resté en échec se renvoie par **Renvoyer**, après vérification de l'adresse.

### 12.4 Autoriser ou refuser l'accès du support

*Qui : propriétaire. Chemin : Support.*

L'équipe Kora n'a pas accès aux données de l'entreprise. Pour aider, elle demande une autorisation précisant le motif, le périmètre et la durée.

1. Lire la demande.
2. **Accepter** si elle correspond à une demande d'aide de l'entreprise ; sinon **Refuser**.
3. Une fois le problème réglé, **Révoquer** l'accès sans attendre sa fin.

Chaque consultation du support apparaît au journal d'audit.
`,
  },
  {
    id: 'abonnement', title: '13. Abonnement', body: `
*Qui : propriétaire, ou utilisateur ayant le droit « Changer de formule, payer l'abonnement ». Chemin : Abonnement.*

### 13.1 Payer l'abonnement

1. Ouvrir **Factures à régler** et cliquer sur **Payer**.
2. Suivre le paiement en ligne. La facture passe « Payée » et la période est renouvelée.

L'historique des factures reste consultable sur la même page.

### 13.2 Changer de formule

1. Dans **Changer de formule**, choisir mensuel ou annuel (2 mois offerts), puis la formule. Chaque carte détaille les modules inclus.
2. Confirmer.

- **Montée en gamme** : facturée au prorata, active dès le paiement.
- **Descente** : appliquée à l'échéance. Aucune donnée n'est supprimée si l'entreprise dépasse une limite ; les modules retirés disparaissent seulement du menu.

### 13.3 Comprendre le cycle de l'abonnement

1. **Essai** : 14 jours, toutes les fonctions de la formule.
2. **Actif** : abonnement payé.
3. **Délai de grâce** : la facture n'est pas réglée à l'échéance. L'application fonctionne encore et un rappel est envoyé.
4. **Suspendu** : à la fin du délai de grâce, l'espace passe en **lecture seule**. On peut consulter et exporter les données, mais plus rien saisir. Le paiement réactive l'espace immédiatement.

Pour résilier, utiliser la résiliation à l'échéance ; tant que l'échéance n'est pas atteinte, **Annuler la résiliation** la révoque. Exporter toutes les données avant la date de fin (3.7).
`,
  },
  {
    id: 'rapports', title: '14. Rapport de gestion', module: 'sales', body: `
Le rapport de gestion répond à une question : l'entreprise gagne-t-elle de l'argent sur la période ? Il est calculé sur les opérations elles-mêmes, sans attendre la comptabilité, et compare chaque chiffre à la période précédente de même durée.

*Qui : propriétaire, directeur, comptable, responsable financier, auditeur. Chemin : Rapports.*

1. Choisir la période (**Ce mois**, **Mois dernier**, **3 derniers mois**, **Cette année**) ou saisir les dates.
2. Lire les quatre indicateurs : chiffre d'affaires TTC, marge brute, dépenses, résultat ; sous chacun, l'évolution par rapport à la période précédente.
3. Analyser les ventes par jour (par mois au-delà de deux mois), les encaissements par mode de paiement, le compte de résultat, les dépenses par poste et les articles les plus vendus.
4. **Exporter (CSV)** pour un tableur, ou **Imprimer / PDF**.

Quatre autres onglets reprennent la même période :

| Onglet | Ce qu'il montre |
| --- | --- |
| Trésorerie | Vue d'ensemble, Caisse, Banque ou Mobile money : solde au début et à la fin, entrées par origine, sorties par destination, point bas, écarts de caisse, détail par compte. Les virements entre vos comptes ne comptent pas dans la vue d'ensemble |
| Stocks | Valeur du stock au début et à la fin, coût des ventes, rotation, couverture en jours, sorties par nature (ventes, casse, consommation…), situation de chaque article (rupture, stock bas, sans vente) |
| Clients | Ventes par client et leur évolution, nouveaux clients, panier moyen, encaissements, délai moyen de paiement, reste à encaisser et balance âgée (non échu, 1 à 30 jours de retard…) |
| Fournisseurs | Achats par fournisseur, règlements, reste à payer, retards et échéancier (en retard, dans les 7 jours, dans les 30 jours). Formules avec le module Achats |

Les montants restant dus (clients et fournisseurs) sont toujours ceux du jour, quelle que soit la période choisie.

| Indicateur | Calcul |
| --- | --- |
| Chiffre d'affaires | Factures émises moins avoirs, à leur date d'émission |
| Marge brute | Ventes HT moins coût des marchandises vendues (au coût moyen) |
| Dépenses | Dépenses de trésorerie (hors retraits de l'exploitant), achats facturés hors marchandises stockées, pertes de stock, écarts d'inventaire et de caisse, charges de personnel des paies validées |
| Résultat | Marge brute − dépenses + autres recettes, avant impôt |

Les achats de marchandises comptent au moment de leur vente, par le coût des marchandises vendues. Les charges de personnel ne figurent que pour les personnes autorisées à voir les salaires. Avec un site choisi dans l'en-tête, le rapport ne porte que sur ce site. Les états comptables officiels restent dans Comptabilité (section 9).
`,
  },
  {
    id: 'console', title: '15. Console éditeur (équipe Kora)', platformOnly: true, body: `
Cette section concerne uniquement l'équipe de l'éditeur. La console affiche les informations commerciales des clients (formule, abonnement, utilisateurs), jamais leurs données métier. La double authentification y est exigée en production.

### 15.1 Préparer une entreprise pour un client

*Chemin : Console › Préparer une entreprise › Nouvelle entreprise.*

1. **Créer** : raison sociale, forme juridique, ville, formule et rythme de facturation (mensuel ou annuel). Le site principal, une caisse, un compte bancaire et un compte mobile money sont créés d'office.
2. **Fiche de l'entreprise** : logo, NCC, régime fiscal, adresse, téléphone, e-mail. Elle figure sur les devis et factures ; le client pourra changer le logo après la remise.
3. **Formule** : ajuster la formule, le rythme et la durée de l'essai. L'essai démarre le jour de la remise, pas le jour de la préparation.
4. **Sites** : ajouter les magasins, succursales et dépôts ; chacun reçoit son entrepôt et sa caisse.
5. **Trésorerie** : compléter les caisses, banques (RIB) et comptes mobile money, chacun rattaché à un site.
6. **Utilisateurs** : indiquer le propriétaire (obligatoire) et les collaborateurs avec leur rôle et leurs sites.

Le panneau **Avancement** indique ce qui reste à faire. Kora refuse la remise si la formule ne couvre pas tous les utilisateurs prévus.

### 15.2 Remettre l'entreprise au client

1. Cliquer sur **Remettre au client**.
2. Les invitations partent par e-mail : invitation de propriétaire pour le client, invitations pour les collaborateurs. Les liens peuvent aussi être copiés et transmis autrement.
3. Si le propriétaire n'a pas reçu l'e-mail, **Renvoyer l'invitation du propriétaire** (possible tant qu'il n'a pas rejoint l'entreprise).

Après la remise, l'entreprise appartient au client : la console ne la modifie plus et n'en voit plus le contenu.

### 15.3 Aider un client après la remise

1. Dans *Clients et indicateurs*, cliquer sur **Demander un accès** et saisir le motif (visible par le client).
2. Attendre que le propriétaire l'accepte (12.4). L'accès est limité dans le temps et chaque consultation est inscrite dans son journal d'audit.

**Suspendre** ou **Réactiver** un client se fait depuis la même liste, avec un motif.
`,
  },
  {
    id: 'annexes', title: 'Annexes', body: `
### A. Rôles standard

Chaque entreprise reçoit ces 11 rôles. Ils se modifient (sauf Propriétaire) et se combinent : un utilisateur peut cumuler plusieurs rôles.

| Rôle | Fait au quotidien | Valide |
| --- | --- | --- |
| Propriétaire / administrateur | Tout, y compris les permissions sensibles | Tout |
| Directeur / gérant | Consulte et exporte tous les modules, planifie, évalue | Ventes, achats, caisse, banque, congés, paie, évaluations |
| Comptable | Contacts, articles, stock, achats, banque, comptabilité ; consulte ventes, caisse, paie | Stock, achats, banque, écritures ; clôture et contre-passation |
| Responsable financier | Banque ; consulte le reste | Ventes, achats, caisse, banque, comptabilité |
| Caissier | Encaissements et décaissements de caisse ; consulte contacts, articles, ventes | — |
| Commercial | Contacts, devis, commandes, factures en brouillon, calendrier | — |
| Magasinier | Bons d'entrée, de sortie, transferts, inventaires | Bons de stock |
| Responsable RH | Employés, congés, évaluations | Congés, évaluations |
| Gestionnaire de paie | Paie, fiches employés ; voit salaires et coordonnées bancaires | Paie |
| Employé | Son espace : sa fiche, ses congés, ses bulletins, ses évaluations | — |
| Auditeur / consultant | Lecture seule et exports, accès limité dans le temps | — |

**Séparation des tâches conseillée** : celui qui saisit n'est pas celui qui valide. Le commercial prépare la facture, un responsable l'émet ; le caissier encaisse, un responsable fait l'arrêté ; le RH prépare, le gestionnaire de paie valide.

### B. Messages fréquents et conduite à tenir

| Message de Kora | Cause | Que faire |
| --- | --- | --- |
| Ce module n'est pas inclus dans votre formule | Module hors formule | Changer de formule (13.2) |
| Votre compte est en lecture seule | Abonnement suspendu ou résilié | Régler l'abonnement (13.1) |
| Trop de tentatives échouées | 5 mots de passe erronés | Attendre 15 minutes ou réinitialiser (2.4) |
| Pour une entreprise, renseignez : … | Fiche contact incomplète | Compléter les champs cités (4.1) |
| Stock insuffisant | Sortie supérieure au disponible | Vérifier l'entrepôt, passer l'entrée manquante ou un inventaire |
| … est validé(e) : il n'est plus modifiable | Document définitif | Avoir, bon inverse ou contre-passation |
| Le montant dépasse le reste à payer | Encaissement ou règlement trop élevé | Saisir le reste exact ; un trop-perçu se rembourse |
| La comptabilité est clôturée jusqu'au … | Période clôturée | Dater l'opération après la clôture |
| Solde insuffisant dans « Caisse… » | La caisse ne contient pas la somme | Vérifier les saisies, alimenter la caisse par un virement |
| Cette facture fournisseur est déjà enregistrée | Doublon de numéro fournisseur | Ouvrir la facture existante |
| Solde de congés insuffisant | Demande supérieure au solde | Réduire la durée ou choisir un congé sans solde |

### C. Contrôles périodiques

| Fréquence | Contrôle | Qui | Section |
| --- | --- | --- | --- |
| Chaque jour | Arrêté de caisse | Caissier et responsable | 8.4 |
| Chaque jour | Valider les bons de stock en brouillon | Magasinier | 5.4 |
| Chaque semaine | Relances clients et échéancier fournisseurs | Commercial, comptable | 6.6, 7.3 |
| Chaque mois | Rapprochement bancaire et mobile money | Comptable | 8.6 |
| Chaque mois | Paie, paiement des salaires, déclarations CNPS et ITS | Gestionnaire de paie | 11.3, 11.4 |
| Chaque mois | Déclaration de TVA, puis clôture de la période | Comptable | 9.4, 9.6 |
| Chaque mois | Revue du journal d'audit et des accès utilisateurs | Propriétaire | 3.4, 3.6 |
| Chaque trimestre | Export intégral des données | Propriétaire | 3.7 |
| Chaque année | Inventaire, valorisation du stock, clôture d'exercice | Magasinier, comptable | 5.5, 5.7, 9.7 |
| Chaque année | Mise à jour des paramètres de paie et campagne d'évaluation | Gestionnaire de paie, RH | 11.1, 10.4 |
`,
  },
];
