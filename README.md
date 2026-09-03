# Test du Live View du Sony A7R II

Petit prototype Android/Expo destiné à répondre à une seule question : le module
`expo-sony-camera` peut-il se connecter au Sony A7R II par Wi-Fi et afficher son
Live View ScalarWebAPI ?

Le projet utilise `expo-sony-camera` 0.2.1. Le module est natif : **Expo Go ne
peut pas exécuter cette application**. Il faut construire et installer l'APK.

## Correspondance avec le contrôleur ESP32 existant

Le contrôleur ESP32 fourni utilise le chemin A7R II suivant :

- caméra 192.168.122.1 ;
- commandes HTTP sur le port 8080 ;
- endpoint /sony/camera ;
- appel startRecMode avant la prise de contrôle ;
- appels startLiveview et stopLiveview.

Le module Expo effectue la même séquence. Il commence par lire le descripteur
ScalarWebAPI sur le port 64321, en déduit l'URL /sony/camera, interroge
getAvailableApiList, appelle startRecMode lorsqu'il est annoncé, puis lance
startLiveview. L'application force explicitement le protocole
sony_scalar_webapi_v1 et le transport scalar_http afin de ne pas sélectionner
accidentellement un périphérique USB.

Le SSID et le mot de passe ne sont pas intégrés à l'application : Android doit
être connecté manuellement au réseau du Sony avant le test.

## Préparer le PC Windows

Installer uniquement :

1. Node.js LTS : <https://nodejs.org/>
2. Git : <https://git-scm.com/download/win>
3. Un compte Expo gratuit : <https://expo.dev/signup>

Android Studio n'est pas nécessaire pour cette première validation.

## Construire l'APK dans le cloud

Ouvrir PowerShell dans le répertoire du projet, puis exécuter :

```powershell
npm install
npx eas-cli login
npm run build:apk
```

Lors de la première compilation, EAS peut proposer de créer/configurer le projet
et les identifiants Android. Accepter la génération automatique des identifiants.

À la fin, EAS affiche un lien. L'ouvrir sur le téléphone Android pour télécharger
et installer l'APK. Android peut demander d'autoriser l'installation depuis le
navigateur utilisé.

## Tester avec l'A7R II

1. Sur le Sony, lancer l'application **Smart Remote Control**.
2. Attendre que le Sony affiche le SSID et le mot de passe de son réseau Wi-Fi.
3. Sur Android, se connecter à ce réseau. Accepter de rester connecté même si
   Android indique qu'il n'a pas accès à Internet.
4. Ouvrir **A7R II Live View Test**.
5. Appuyer sur **Connexion Wi-Fi Sony**.
6. Si l'état devient `ready`, appuyer sur **Démarrer Live View**.
7. Si l'état devient `streaming` et qu'une image apparaît, le test est réussi.

Le module cherche le service Sony par SSDP, puis essaie aussi les adresses Wi-Fi
Direct connues `192.168.122.1` et `192.168.0.1`.

## En cas d'échec

Ne pas désinstaller immédiatement l'application. Copier le texte visible dans la
zone **Diagnostics** ou faire plusieurs captures d'écran, notamment après avoir
appuyé sur **Connexion** puis sur **Démarrer Live View**.

Les états les plus utiles sont :

- `ready` : connexion et découverte Sony réussies ;
- `streaming` : le flux JPEG est reçu ;
- `error` : lire le message et les diagnostics ;
- `disconnected` après tentative : le Sony n'a probablement pas été trouvé ;
- `unsupported` : le module natif n'a pas été inclus dans l'APK.

Après connexion, la fiche d'état doit afficher le protocole
sony_scalar_webapi_v1 et le transport scalar_http.

## Limitation connue

Le module annonce un chemin ScalarWebAPI Android fonctionnel, mais l'A7R II
n'est pas officiellement certifié par son auteur. Ce prototype sert précisément
à réaliser cette validation matérielle avant de développer l'alignement par
dérive.
