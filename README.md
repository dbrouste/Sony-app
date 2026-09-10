# AstroTrac Drift Align avec Sony A7R II

Application Android expérimentale pour aider à l’alignement polaire d’une monture
équatoriale AstroTrac dans l’hémisphère Sud, sans viseur polaire.

Le téléphone se connecte directement au Wi-Fi créé par l’application
**Smart Remote Control** du Sony A7R II. Il affiche le Live View, permet de
sélectionner automatiquement jusqu’à 12 étoiles et suit leur déplacement commun afin de mesurer la dérive.

> La chaîne mono-étoile a été validée sur le ciel. Le suivi multi-étoiles et la mesure complète de dérive restent à valider sur le terrain. L’application ne commande pas l’AstroTrac et ne fournit pas encore automatiquement le sens de correction des vis d’azimut et d’altitude.

## État du projet

| Fonction | État | Remarque |
| --- | --- | --- |
| Connexion Wi-Fi au Sony A7R II | Validée | ScalarWebAPI via Smart Remote Control |
| Découverte SSDP du boîtier | Validée | Avec essais de secours sur les adresses Sony connues |
| Démarrage du mode distant et du Live View | Validé | Séquence compatible avec l’A7R II |
| Affichage continu du Live View | Validé | Environ 10 images/s observées |
| Zoom tactile et boutons +/− | Validé | Zoom d’affichage de ×1 à ×10 |
| Déplacement dans l’image zoomée | Validé | Glissement à un doigt |
| Sélection d’une étoile par toucher | Validée | Les coordonnées tiennent compte du zoom et du déplacement |
| Sélection automatique d’une étoile | Validée sur le ciel | Perte/reprise, étoile faible, saturation et perturbations testées en mono-étoile |
| Sélection automatique multi-étoiles | Implémentée, à tester | Choisit de 1 à 12 étoiles isolées, non saturées et éloignées des bords |
| Suivi multi-étoiles | Implémenté, à tester | Consensus robuste des vecteurs puis moyenne pondérée par SNR et HFD |
| Suivi du centroïde de l’étoile | Validé sur le ciel | Calcul natif Android à 5 mesures/s, inspiré de PHD2 |
| Filtrage temporel sur 1 seconde | Validé sur le ciel | Régression pour l’affichage et médiane par seconde pour la trace |
| Qualité Live View maximale | Implémentée, à confirmer | Demande de taille Sony `M` si disponible, sinon repli automatique |
| Réduction de la latence d’affichage | Implémentée, à tester | Les anciennes images sont abandonnées au lieu d’être mises en file |
| Trace de déplacement de l’étoile | Validée sur le ciel | Jusqu’à 120 points, soit environ 2 minutes |
| Droite robuste de la trace | Validée sur le ciel | Ajustement robuste et rejet des points aberrants |
| Référence monture arrêtée | Implémentée, à tester | Acquisition guidée puis gel de la droite robuste |
| Mesure de dérive signée | Implémentée, à tester | Écart perpendiculaire et pente robuste en pixels par minute |
| EAS Update | Configuré | Vérification et installation également disponibles depuis l’application |
| Identification de la version | Implémentée | SHA Git publié et identifiant court de l’OTA exécutée |
| Guidage azimut/altitude complet | À développer | Voir la feuille de route |

## Principe de la mesure

Le fonctionnement visé reprend la méthode proposée pour l’AstroTrac :

1. choisir une étoile adaptée au réglage de l’azimut ou de l’altitude ;
2. arrêter le suivi de la monture et enregistrer la direction naturelle de
   déplacement de l’étoile ;
3. redémarrer le suivi sidéral ;
4. mesurer l’écart perpendiculaire de l’étoile par rapport à cette droite ;
5. ajuster l’azimut ou l’altitude jusqu’à ce que cet écart reste stable.

L’application sépare désormais l’acquisition de la trace, le gel de la droite de
référence et la mesure de dérive lorsque le suivi sidéral est redémarré.

## Fonctions actuellement disponibles

### Connexion au Sony

Le module `expo-sony-camera` est configuré pour reproduire le fonctionnement du
contrôleur ESP32 utilisé avec l’A7R II :

- caméra généralement accessible sur `192.168.122.1` ;
- descripteur ScalarWebAPI sur le port `64321` ;
- commandes HTTP sur le port `8080` ;
- endpoint `/sony/camera` ;
- appel de `startRecMode` avant la prise de contrôle lorsqu’il est disponible ;
- appels `startLiveviewWithSize` ou `startLiveview`.

Le code accepte les URL absolues, relatives ou sans protocole annoncées par les
anciennes versions de Smart Remote Control. Il accepte également l’absence
d’URL Live View dans le descripteur : l’A7R II renvoie alors l’URL active lors de
l’appel `startLiveview`.

Le SSID et le mot de passe ne sont pas stockés dans l’application. Android doit
être connecté manuellement au réseau Wi-Fi du Sony, même s’il indique que ce
réseau ne fournit pas d’accès à Internet.

### Navigation et sélection

Pendant le Live View :

- pincer avec deux doigts pour zoomer ;
- utiliser les boutons **+** et **−** pour zoomer par pas ;
- glisser à un doigt pour déplacer l’image lorsqu’elle est zoomée ;
- toucher brièvement une étoile pour la sélectionner ;
- utiliser **Sélection automatique** pour rechercher de 1 à 12 étoiles non saturées, isolées et éloignées des bords ;
- contrôler l’état de chaque étoile : vert = retenue, jaune = rejetée par le consensus, rouge = perdue ;
- vérifier l’indication `X/Y ÉTOILES VERROUILLÉES` et le temps de traitement natif ;
- utiliser **Réinitialiser zoom et sélection** pour recommencer.

Le zoom est uniquement un agrandissement de l’image reçue. Il ne modifie pas le
zoom optique ou numérique du Sony.

### Suivi mono-étoile et multi-étoiles

Le suivi est exécuté dans le module Android natif afin d’éviter de transférer
chaque JPEG vers JavaScript. Toutes les 200 ms, il :

- recherche une source lumineuse près de la dernière position connue ;
- lisse la zone avec un noyau pondéré 3×3 pour limiter les faux pics JPEG ;
- estime le fond dans une couronne autour de l’étoile avec rejet sigma itératif ;
- calcule un centroïde pondéré dans une ouverture circulaire adaptative ;
- calcule la masse, un SNR relatif, le HFD et un indicateur de saturation ;
- publie la position, le déplacement `dx/dy` et l’état verrouillé/perdu.

Cette chaîne reprend les principes du calcul de centroïde de
[PHD2](https://github.com/OpenPHDGuiding/phd2/blob/master/src/star.cpp), mais
elle est adaptée au Live View couleur, compressé, gamma-corrigé et limité à
8 bits du Sony. La préférence pour la source proche de la position précédente
est conservée afin d’éviter un saut vers une autre étoile. Une mesure saturée,
de SNR insuffisant ou de diamètre incohérent n’est pas ajoutée à la trace.

En sélection automatique, le module suit jusqu’à 12 étoiles en parallèle. Il
calcule le déplacement médian du groupe, rejette par MAD les vecteurs incohérents,
puis combine les étoiles retenues avec une pondération fondée sur leur SNR et
leur HFD. Le résultat redevient automatiquement mono-étoile si une seule source
reste valide. Les étoiles trop proches du bord ne sont jamais sélectionnées.

La position agrégée affichée est lissée par une régression linéaire sur la dernière
seconde, ce qui réduit le bruit sans introduire le retard d’une moyenne mobile.
Le verrouillage natif continue cependant d’utiliser les mesures brutes.

La trace reçoit une position médiane par intervalle indépendant d’une seconde et
conserve jusqu’à 120 positions, soit environ deux minutes. Les points acceptés
par l’ajustement sont affichés en bleu et les points aberrants en orange.

### Droite robuste

La direction de la trace est estimée en trois étapes :

1. recherche d’un consensus à partir de paires de points ;
2. ajustement orthogonal par moindres carrés totaux ;
3. rejet itératif des valeurs aberrantes à partir de la médiane et du MAD.

La droite cyan n’apparaît qu’après un nombre suffisant de mesures cohérentes.
Les passages nuageux, pertes momentanées de verrouillage ou faux centroïdes
doivent ainsi avoir moins d’influence sur la direction calculée.

### Mesure de dérive

L’assistant impose trois phases distinctes :

1. **Acquérir la référence** avec l’AstroTrac arrêté pendant au moins 12 secondes ;
2. **Figer la référence**, puis démarrer le suivi sidéral de l’AstroTrac ;
3. **Démarrer la mesure** pour calculer l’écart signé à la droite figée.

Une position médiane est mesurée chaque seconde. Une régression temporelle robuste
affiche la pente en pixels par minute, l’écart signé courant, le RMS et le nombre
de points retenus. La droite de référence indique également son angle et une
estimation de l’incertitude angulaire. En mode multi-étoiles, le temps de
traitement natif est affiché afin de vérifier qu’il reste inférieur à la cadence
de 200 ms. Un segment orange matérialise l’écart perpendiculaire sur
l’image. Les valeurs utilisent les pixels du JPEG Sony et ne dépendent donc pas
du zoom d’affichage.

## Utilisation sur le terrain

1. Sur le Sony, lancer **Smart Remote Control**.
2. Sur Android, rejoindre le Wi-Fi affiché par le Sony.
3. Accepter de rester connecté malgré l’absence d’Internet.
4. Ouvrir l’application.
5. Appuyer sur **Connexion Wi-Fi Sony**.
6. Attendre l’état `ready`.
7. Appuyer sur **Démarrer Live View**.
8. Utiliser **Sélection automatique** ou toucher une étoile après avoir zoomé.
9. Vérifier l’indication **ÉTOILE VERROUILLÉE**.
10. Arrêter l’AstroTrac et appuyer sur **1. Acquérir la référence**.
11. Après au moins 12 secondes, appuyer sur **Figer la référence**.
12. Démarrer le suivi sidéral de l’AstroTrac, puis appuyer sur
    **2. Démarrer la mesure**.
13. Observer la dérive en pixels par minute et l’écart orange à la droite figée.

## Diagnostics

La zone **Diagnostics** affiche les étapes de découverte, les URL résolues, les
API annoncées par le Sony et les métriques du flux.

États utiles :

- `ready` : connexion Sony établie ;
- `streaming` : le flux JPEG est reçu ;
- `error` : consulter le message et les dernières lignes du diagnostic ;
- `disconnected` : caméra absente ou téléphone connecté au mauvais réseau ;
- `unsupported` : module natif absent de l’APK.

Le protocole attendu est `sony_scalar_webapi_v1` et le transport attendu est
`scalar_http`.

Si le Live View s’arrête volontairement parce que le Sony est éteint ou
déconnecté, le message `Sony live-view stream ended` est normal.

## Installation et build Android

Le module Sony contient du code Kotlin natif. L’application ne fonctionne donc
pas dans Expo Go ni directement dans un navigateur.

Dans un Codespace propre et synchronisé :

```bash
git status --short
git pull --ff-only origin main
npm ci
npm run typecheck
npx expo-doctor
npx eas-cli@latest env:set \
  --environment preview \
  --name EXPO_PUBLIC_GIT_COMMIT_SHA \
  --value "$(git rev-parse --short HEAD)" \
  --visibility plaintext
npx eas-cli@latest build --platform android --profile preview
```

Le profil `preview` produit un APK installable directement sur Android. Avant le build, `git status --short` doit idéalement être vide et `git rev-parse --short HEAD` doit correspondre au commit attendu.

Si `patch-package` signale qu’il ne peut pas appliquer `patches/expo-sony-camera+0.2.1.patch`, le dossier `node_modules` contient généralement une ancienne modification. Relancer une installation déterministe :

```bash
npm ci
grep -n "MAX_TRACKING_STARS = 12" \
  node_modules/expo-sony-camera/android/src/main/java/expo/modules/sonycamera/SonyCameraModule.kt
```

La seconde commande doit retrouver la constante native du suivi multi-étoiles. `grep` est utilisé car `rg` n’est pas installé par défaut dans tous les Codespaces.

## Mises à jour EAS Update

Le projet est configuré avec le canal `preview`. Après avoir installé une
première fois le nouvel APK contenant `expo-updates`, une évolution limitée au
code JavaScript/TypeScript, aux styles ou aux ressources peut être publiée sans
recompiler l’APK :

```bash
npx eas-cli@latest env:set \
  --environment preview \
  --name EXPO_PUBLIC_GIT_COMMIT_SHA \
  --value "$(git rev-parse --short HEAD)" \
  --visibility plaintext
npx eas-cli@latest update \
  --channel preview \
  --message "Description de la modification" \
  --environment preview
```

Fermer puis rouvrir complètement l’application permet de télécharger la mise à
jour. Un second redémarrage peut être nécessaire pour l’appliquer.

L’écran affiche le SHA Git, l’identifiant court de l’OTA active et le canal EAS.
Le bouton **Vérifier et installer la mise à jour** effectue immédiatement la
vérification, le téléchargement et le redémarrage. Il faut l’utiliser sur un
réseau fournissant Internet, avant de connecter Android au Wi-Fi du Sony.

Un nouveau build Android reste obligatoire après une modification de :

- la partie Kotlin du module Sony ;
- la configuration ou des permissions Android ;
- une dépendance contenant du code natif ;
- la version native ou la politique de runtime.

## Feuille de route

### Validation immédiate

- [x] valider la sélection automatique mono-étoile ;
- [x] vérifier la perte puis la reprise du verrouillage ;
- [x] tester une étoile faible et une étoile saturée ;
- [x] vérifier le rejet d’une mesure perturbée et la stabilité de la droite robuste ;
- [ ] vérifier que la file d’images ne crée plus plusieurs secondes de retard ;
- [ ] mesurer la latence réelle entre un mouvement devant le Sony et l’écran ;
- [ ] confirmer la résolution Live View effectivement fournie par l’A7R II ;
- [ ] comparer le bruit des positions brutes et filtrées sur une minute ;
- [ ] comparer l’angle et le bruit obtenus avec 1, 4, 8 et 12 étoiles ;
- [ ] masquer plusieurs étoiles et vérifier le repli progressif jusqu’au suivi mono-étoile ;
- [ ] valider le téléchargement et l’application d’une première mise à jour OTA.

### Alignement par dérive

- ajouter un écran ou un assistant distinguant **Azimut** et **Altitude** ;
- [x] ajouter une phase **Monture arrêtée : acquisition de la référence** ;
- [x] figer la droite de référence avant de redémarrer la monture ;
- [x] ajouter une phase **Monture en suivi : mesure de la dérive** ;
- [x] calculer la distance perpendiculaire signée à la droite et son évolution
  dans le temps ;
- afficher une courbe de dérive, une stabilité et une incertitude ;
- convertir la dérive en consigne de correction azimut/altitude ;
- tenir compte de l’orientation de l’image pour éviter une indication de sens
  inversée ;
- proposer un critère clair de validation du réglage.

### Robustesse et ergonomie

- améliorer la reprise après extinction ou perte Wi-Fi du Sony ;
- afficher les FPS, la résolution reçue et une estimation de latence ;
- enregistrer/exporter une session de mesure pour analyse ;
- ajouter un mode nuit à dominante rouge ;
- simplifier l’interface une fois le protocole de mesure validé ;
- tester d’autres boîtiers Sony utilisant ScalarWebAPI.

## Structure technique

- Expo SDK 57 / React Native ;
- `expo-sony-camera` 0.2.1 avec correctifs conservés par `patch-package` ;
- traitement du Live View et suivi robuste du centroïde inspiré de PHD2 en Kotlin ;
- interface, trace et ajustement robuste en TypeScript/React Native ;
- builds APK avec EAS Build ;
- mises à jour non natives avec EAS Update.

## Limites actuelles

- seul le Sony A7R II avec Smart Remote Control a été testé ;
- le suivi multi-étoiles nécessite l’APK natif `0.1.3` ou plus récent ;
- la qualité du Live View reste limitée par ce que le boîtier transmet ;
- le zoom de l’application n’ajoute aucun détail à l’image source ;
- le suivi suppose une étoile suffisamment contrastée et peu de sources plus
  lumineuses à proximité ;
- la pente est exprimée en pixels par minute ; elle n’est pas encore convertie
  en consigne de correction azimut/altitude ;
- les correctifs du module sont appliqués dans `node_modules` par
  `patch-package` après chaque installation.
