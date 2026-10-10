# ParaLens — Traduction PDF et lecture bilingue dans Zotero

ParaLens traduit les PDF avec un worker Python local utilisant BabelDOC 0.6.4, puis ouvre l’original et la traduction dans deux lecteurs natifs de Zotero. Le survol et le clic mettent en évidence les zones dont la correspondance est vérifiable. Le PDF original est conservé.

Le projet est un prototype technique. L’environnement de test GUI local est Windows avec Zotero 10.0.3 ; les autres plateformes et Zotero 7–9 ne disposent pas d’une validation complète. La traduction nécessite un service API configuré par l’utilisateur et peut être facturée.

## Installation

La compilation nécessite Node.js 22.13 ou supérieur et npm :

```sh
npm ci
npm run build
```

Installer `.scaffold/build/zotero-paralens.xpi` depuis le gestionnaire d’extensions de Zotero, puis redémarrer Zotero. Le backend exige uv et Python 3.12 ; npm seul ne suffit pas.

Dans les préférences ParaLens, vérifier le chemin uv, choisir BabelDOC et cliquer sur l’installation du backend si nécessaire. Cette action peut télécharger Python et les dépendances ; BabelDOC peut aussi télécharger des modèles ou des polices. Le démarrage du plugin n’installe pas automatiquement les dépendances.

## Configuration

- Choisir OpenAI, OpenRouter, DeepSeek ou une interface personnalisée compatible Chat Completions.
- Enregistrer la clé API et un identifiant de modèle accessible au compte. Une URL distante doit utiliser HTTPS ; HTTP est autorisé pour loopback local.
- Choisir les langues : anglais ou chinois simplifié, avec des langues source et cible différentes.
- La concurrence des requêtes vaut 4 par défaut (1–16), et la limite de démarrage vaut 2 requêtes par seconde (1–10). Les PDF sont traités l’un après l’autre.
- La réparation automatique des paragraphes probablement non traduits est désactivée par défaut. Le contrôle seul n’envoie pas de requêtes de réparation ; l’option activée s’applique aux nouvelles tâches et peut ajouter des coûts.

Les options sont enregistrées à la mise en file. Redémarrer une tâche conserve ses options et recommence entièrement, sans reprise au point d’arrêt.

## Traduction et lecture

Sélectionner un PDF ou une référence comportant un seul PDF, puis utiliser le menu ParaLens de traduction et confirmer les frais possibles. Les traductions complètes sont importées comme pièces jointes et peuvent être ouvertes en lecture bilingue. Les tâches multiples passent par une file série.

Les lecteurs natifs s’affichent côte à côte. Le survol localise la zone correspondante ; un clic verrouille la mise en évidence. Un nouveau clic sur la même zone, `Esc` ou le bouton de déverrouillage libère le verrou. La synchronisation du défilement est optionnelle et désactivée par défaut ; une position approximative sans correspondance fiable n’est pas un alignement de texte.

Le JSON de correspondance est une pièce jointe Zotero. Sur un autre appareil, synchroniser et télécharger l’original, la traduction et le JSON avant d’ouvrir la comparaison.

## File et résultats partiels

- Les tâches en attente ou en cours peuvent être annulées ; les requêtes déjà envoyées peuvent rester facturées.
- Les tâches échouées ou annulées proposent une suppression de leur ligne. Les PDF, pièces jointes de correspondance et fichiers de travail sont conservés ; aucune API n’est appelée.
- Le redémarrage demande confirmation et remplace la ligne par une nouvelle tâche, sans supprimer les pièces jointes existantes.
- Une omission probable, une erreur de contrôle／réparation ou une erreur partielle permet de tenter la production d’un PDF. Un résultat partiel validé est conservé pour vérification manuelle, sans remplacer la comparaison complète par défaut.
- Une annulation, l’échec de toutes les requêtes API ou l’absence de PDF valide ne sont pas présentés comme une réussite.

## Confidentialité et limites

L’analyse et la mise en page sont locales, mais le texte à traduire est transmis au service API choisi. Les clés sont conservées dans le gestionnaire d’identifiants Gecko et dans une configuration de tâche à usage unique, supprimée après lecture. Ne pas publier les profils Zotero, clés, PDF privés ou fichiers IL.

Le projet ne fournit pas d’OCR ni d’alignement phrase par phrase. Les correspondances incertaines ne sont pas surlignées. Les images exigent du texte vérifiable ou une identité raster unique ; les images ambiguës et les graphiques purement vectoriels ne sont pas appariés de force. Une correspondance géométrique ne garantit pas la qualité linguistique.

## Documentation et licence

- [README principal](../README.md)
- [Configuration et tests du backend](../docs/backend-setup.md)
- [Architecture du projet](../docs/project-architecture.md)
- [Compatibilité](../docs/compatibility.md)
- [Guide de développement](development.md)
- [Licence AGPL-3.0-or-later](../LICENSE) et [mentions tierces](../THIRD_PARTY_NOTICES.md)

ParaLens utilise Zotero Plugin Template et Zotero Plugin Toolkit ; BabelDOC fournit la traduction et la mise en page. Les textes de licence et attributions d’origine sont conservés. Le logiciel est fourni sans garantie ; les résultats importants doivent être vérifiés manuellement.
