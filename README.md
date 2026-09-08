# AstroTrac Drift Align avec Sony A7R II

Application Android expérimentale pour aider à l’alignement polaire d’une monture
équatoriale AstroTrac dans l’hémisphère Sud, sans viseur polaire.

Le téléphone se connecte directement au Wi-Fi créé par l’application
**Smart Remote Control** du Sony A7R II. Il affiche le Live View, permet de
sélectionner une étoile et suit sa position afin de mesurer sa dérive.

> Le projet est encore en phase de validation sur le ciel. Il ne commande pas
> l’AstroTrac et ne fournit pas encore automatiquement le sens de correction des
> vis d’azimut et d’altitude.

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
| Suivi du centroïde de l’étoile | Nouvel estimateur implémenté, à tester | Calcul natif Android à 5 mesures/s, inspiré de PHD2 |
| Qualité Live View maximale | Implémentée, à confirmer | Demande de taille Sony `M` si disponible, sinon repli automatique |
| Réduction de la latence d’affichage | Implémentée, à tester | Les anciennes images sont abandonnées au lieu d’être mises en file |
| Trace de déplacement de l’étoile | Implémentée, à tester sur le ciel | Jusqu’à 600 points, soit environ 2 minutes |
| Droite robuste de la trace | Implémentée, à tester sur le ciel | Ajustement robuste et rejet des points aberrants |
| EAS Update | Configuré, nouveau build requis | Le premier APK compatible OTA doit encore être construit et installé |
| Guidage azimut/altitude complet | À développer | Voir la feuille de route |

## Principe de la mesure

Le fonctionnement visé reprend la méthode proposée pour l’AstroTrac :

1. choisir une étoile adaptée au réglage de l’azimut ou de l’altitude ;
2. arrêter le suivi de la monture et enregistrer la direction naturelle de
   déplacement de l’étoile ;
3. redémarrer le suivi sidéral ;
4. mesurer l’écart perpendiculaire de l’étoile par rapport à cette droite ;
5. ajuster l’azimut ou l’altitude jusqu’à ce que cet écart reste stable.

L’application sait déjà sélectionner et suivre l’étoile ainsi qu’approximer sa
trace. Les étapes séparant explicitement l’acquisition de la droite de référence
et la mesure de dérive restent à ajouter.

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
- utiliser **Réinitialiser zoom et sélection** pour recommencer.

Le zoom est uniquement un agrandissement de l’image reçue. Il ne modifie pas le
zoom optique ou numérique du Sony.

### Suivi de l’étoile

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

L’interface conserve jusqu’à 600 positions verrouillées. Les points acceptés par
l’ajustement sont affichés en bleu et les points aberrants en orange.

### Droite robuste

La direction de la trace est estimée en trois étapes :

1. recherche d’un consensus à partir de paires de points ;
2. ajustement orthogonal par moindres carrés totaux ;
3. rejet itératif des valeurs aberrantes à partir de la médiane et du MAD.

La droite cyan n’apparaît qu’après un nombre suffisant de mesures cohérentes.
Les passages nuageux, pertes momentanées de verrouillage ou faux centroïdes
doivent ainsi avoir moins d’influence sur la direction calculée.

## Utilisation sur le terrain

1. Sur le Sony, lancer **Smart Remote Control**.
2. Sur Android, rejoindre le Wi-Fi affiché par le Sony.
3. Accepter de rester connecté malgré l’absence d’Internet.
4. Ouvrir l’application.
5. Appuyer sur **Connexion Wi-Fi Sony**.
6. Attendre l’état `ready`.
7. Appuyer sur **Démarrer Live View**.
8. Zoomer, centrer une étoile assez brillante et la toucher.
9. Vérifier l’indication **ÉTOILE VERROUILLÉE** et observer `dx`, `dy`,
   contraste et bruit.
10. Pour le moment, interpréter la trace et la droite manuellement.

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

Dans un Codespace :

```bash
npm install
npx expo-doctor
npx eas-cli@latest build --platform android --profile preview
```

Le profil `preview` produit un APK installable directement sur Android.

## Mises à jour EAS Update

Le projet est configuré avec le canal `preview`. Après avoir installé une
première fois le nouvel APK contenant `expo-updates`, une évolution limitée au
code JavaScript/TypeScript, aux styles ou aux ressources peut être publiée sans
recompiler l’APK :

```bash
npx eas-cli@latest update \
  --channel preview \
  --message "Description de la modification" \
  --environment preview
```

Fermer puis rouvrir complètement l’application permet de télécharger la mise à
jour. Un second redémarrage peut être nécessaire pour l’appliquer.

Un nouveau build Android reste obligatoire après une modification de :

- la partie Kotlin du module Sony ;
- la configuration ou des permissions Android ;
- une dépendance contenant du code natif ;
- la version native ou la politique de runtime.

## Feuille de route

### Validation immédiate

- vérifier que la file d’images ne crée plus plusieurs secondes de retard ;
- mesurer la latence réelle entre un mouvement devant le Sony et l’écran ;
- confirmer la résolution Live View effectivement fournie par l’A7R II ;
- tester la stabilité du verrouillage sur des étoiles de luminosités différentes ;
- vérifier le rejet des faux points et la droite robuste sur une séquence réelle ;
- valider le téléchargement et l’application d’une première mise à jour OTA.

### Alignement par dérive

- ajouter un écran ou un assistant distinguant **Azimut** et **Altitude** ;
- ajouter une phase **Monture arrêtée : acquisition de la référence** ;
- figer la droite de référence avant de redémarrer la monture ;
- ajouter une phase **Monture en suivi : mesure de la dérive** ;
- calculer la distance perpendiculaire signée à la droite et son évolution dans
  le temps ;
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
- la qualité du Live View reste limitée par ce que le boîtier transmet ;
- le zoom de l’application n’ajoute aucun détail à l’image source ;
- le suivi suppose une étoile suffisamment contrastée et peu de sources plus
  lumineuses à proximité ;
- la droite calculée représente une trajectoire d’image, pas encore une
  correction polaire directement exploitable ;
- les correctifs du module sont appliqués dans `node_modules` par
  `patch-package` après chaque installation.
