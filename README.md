# Tombola des 10 ans du NAM-IP

Application de tirage au sort qui fonctionne sans installation ni connexion. Le hasard vient de `crypto.getRandomValues` (générateur sécurisé du navigateur). Les tickets ne sont désignés que par leur numéro court (1, 2, 3…).

## Lancer l'application

- **Depuis le disque** : double-cliquer sur `index.html` (adresse `file://…`).
- **Via GitHub Pages** : activer Pages sur la branche principale, dossier racine, puis ouvrir l'adresse `https://<compte>.github.io/<dépôt>/`.

Navigateur conseillé : Chrome, Edge ou Firefox, en version récente.

## Fichiers à préparer (CSV UTF-8, séparateur `;`)

Des exemples sont fournis dans `modeles/` (données de DÉMONSTRATION), et le bouton « Télécharger les modèles CSV » les télécharge aussi.

- `lots.csv` : `lot_id;description`. Le `lot_id` est un entier unique ≥ 1, jamais renuméroté.
- `achats.csv` : `acheteur_id;nom;ticket_debut;ticket_fin`, une ligne par plage de tickets, bornes incluses. Un acheteur qui a plusieurs plages a plusieurs lignes avec le même `acheteur_id`.

Seuls les tickets listés participent : un numéro absent du fichier n'existe pas pour le tirage. Un fichier invalide est refusé en entier, avec le numéro de ligne de chaque erreur, et l'import précédent est conservé.

## Règle du tirage

- S'il y a **au plus autant d'acheteurs que de lots**, la garantie est active : chaque acheteur gagne au moins un lot (un de ses tickets est tiré au hasard), puis les lots restants sont tirés parmi les autres tickets.
- S'il y a **plus d'acheteurs que de lots**, la garantie est désactivée et le tirage est classique.
- Un ticket gagne au plus un lot. S'il y a moins de tickets que de lots, les lots en trop sont « non attribués ».

## Procédure du jour J

1. **Avant l'événement**, sur le PC du tirage : ouvrir l'app, charger la DÉMONSTRATION, faire un tirage d'essai, puis cliquer sur « Effacer la démo ».
2. **Importer** `lots.csv` puis `achats.csv`. Vérifier le récapitulatif : nombre d'acheteurs, de tickets et de lots, mode, trous signalés.
3. **Tirer au sort** et confirmer. Le CSV du résultat se télécharge automatiquement : le copier aussitôt sur une clé USB. C'est la vraie sauvegarde.
4. **Imprimer la liste** (par lot, et par ticket si utile) : la colonne « Remis ☐ » se coche à la main lors de la remise des lots.
5. **Pendant l'événement**, onglet « Vérification » : taper un numéro (`7`) ou une plage (`5-10`), puis Entrée.
6. **Sur un autre PC**, si besoin : ouvrir l'app, onglet « Vérification », « Importer un résultat » avec le CSV de l'étape 3. Ce PC passe en consultation, sans nouveau tirage.

## Limites à connaître

- **Pas de synchronisation entre PC.** Chaque ordinateur garde sa propre copie. On partage le résultat avec le fichier CSV.
- **Le stockage du navigateur (localStorage) est lié à l'adresse et au navigateur.** Un tirage fait dans Chrome n'apparaît pas dans Firefox, et un tirage fait en `file://` n'apparaît pas sur l'adresse GitHub Pages, et inversement. **Sur un même PC, ne pas mélanger `file://` et l'URL GitHub** : choisir une seule façon d'ouvrir l'app et s'y tenir.
- Ce stockage peut être vidé (navigation privée, nettoyage du navigateur, autre profil). Rien n'est indestructible : **le CSV exporté est la sauvegarde**.
- **« Supprimer le résultat »** (onglet Vérification, confirmation en tapant EFFACER) efface le tirage de cet ordinateur et garde les lots et achats importés : **il permet donc un nouveau tirage**. Le jour J, ne l'utiliser qu'en cas d'erreur avérée. « Tout effacer » supprime en plus les lots et les achats. Avant le tirage, « Supprimer la liste de lots » et « Supprimer les achats » retirent un import.
- Aucun suivi de remise dans l'app : la remise se note sur papier.
- Limite de sécurité : 1 000 000 de tickets au total par import.

## Confidentialité

Le dépôt est public : le `.gitignore` exclut tout fichier `*.csv` et `*.json` hors de `modeles/`. Ne jamais forcer l'ajout d'un fichier de vraies données.

## Tests

```
node --test "tests/*.test.js"
```

Avec Node 24, `node --test tests/` ne fonctionne pas : Node prend le dossier pour un fichier. Il faut passer le motif ci-dessus.

Test d'interface (Playwright pour Python, Chromium sans fenêtre). Le dossier passé en argument reçoit les CSV téléchargés et doit se trouver hors du dépôt :

```
python tests/ui/test_ui.py <dossier_temporaire>
```
