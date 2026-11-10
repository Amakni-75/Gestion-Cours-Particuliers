# Gestion des cours particuliers

Application statique publiée sur GitHub Pages, avec authentification et
synchronisation multi-appareils par compte via Supabase. Chaque compte ne peut
accéder qu'à ses propres élèves, matières, séances et échéances. Les
administrateurs approuvent ou refusent les nouvelles inscriptions depuis
l'application, mais n'ont pas accès aux données privées des comptes.

Après connexion, le tableau de bord réunit les dépenses, le calendrier des
séances et les échéances de paiement ; ses filtres par mois et par élève
s'appliquent à ces trois vues. La navigation donne aussi accès aux écrans
Élèves, Matières et Séances & paiements. Les fiches élèves permettent de
modifier leur nom et de gérer leurs matières et tarifs ; le catalogue permet
de créer, renommer et supprimer les matières. L'écran **Adhésions** est réservé
aux administrateurs et centralise l'approbation des comptes.

## Mise en service

1. Créez un projet Supabase et ouvrez son **SQL Editor**.
2. Exécutez le contenu de [`supabase_schema.sql`](./supabase_schema.sql).
3. Dans **Authentication > URL Configuration**, définissez l'URL du site et
   ajoutez l'URL exacte `https://amakni-75.github.io/Gestion-Cours-Particuliers/`
   aux URL de redirection autorisées. Cette URL doit être autorisée pour que
   les liens de confirmation reviennent sur GitHub Pages, et non sur une URL
   locale comme `http://localhost:3000`. Activez les inscriptions par e-mail
   et configurez la confirmation d'adresse e-mail selon les règles de votre
   organisation.
4. Dans **Project Settings > API**, copiez l'URL du projet et la clé
   **publishable** (ou l'ancienne clé `anon`) dans [`supabase-config.js`](./supabase-config.js).
   Cette clé est destinée au navigateur ; n'y mettez jamais la clé
   `service_role`.
5. Publiez `index.html` et `supabase-config.js` dans le dépôt GitHub, puis
   activez **Settings > Pages** sur la branche et le dossier souhaités. `index.html`
   est la page d'entrée de l'URL GitHub Pages ; les deux fichiers doivent être
   servis depuis le même dossier. Si le fichier de configuration change après
   publication, incrémentez son paramètre `?v=...` dans la balise script du HTML
   afin d'éviter une ancienne configuration conservée dans le cache du navigateur.
6. Créez le compte de l'administrateur depuis l'application et confirmez son
   adresse e-mail. Dans le SQL Editor Supabase, exécutez la requête de
   promotion commentée à la fin de `supabase_schema.sql`, en remplaçant
   l'adresse d'exemple par celle du compte administrateur.
7. Les utilisateurs créent leur compte depuis l'application, confirment leur
   e-mail si demandé, puis attendent l'approbation de l'administrateur.
   Si un lien de confirmation affiche `otp_expired`, demandez-en un nouveau
   dans l'application et utilisez le dernier e-mail reçu : un lien expiré ou
   déjà utilisé ne peut pas être réutilisé.

   ## Rappels de séance par e-mail

   Chaque séance enregistrée peut déclencher un rappel à l'adresse e-mail de
   l'élève ou du parent, environ 24 heures puis 2 heures avant son début. Saisissez
   l'adresse dans la fiche de l'élève et l'heure lors de l'ajout ou de la
   modification de chaque séance. Les anciennes séances n'ont pas d'heure :
   modifiez-les pour leur en attribuer une avant qu'elles puissent déclencher un
   rappel. Les séances récurrentes doivent actuellement être enregistrées une par
   une.

   L'envoi fonctionne même lorsque l'application est fermée : il nécessite une
   fonction Supabase Edge planifiée et un compte d'envoi [Resend](https://resend.com/)
   avec une adresse expéditrice vérifiée. Après avoir mis à jour le schéma avec
   [`supabase_schema.sql`](./supabase_schema.sql), configurez les secrets et
   déployez la fonction depuis la racine du projet avec la CLI Supabase :

   ```powershell
   supabase login
   supabase link --project-ref <project-ref>
   supabase secrets set RESEND_API_KEY=<cle-resend> REMINDER_CRON_SECRET=<secret-aleatoire> REMINDER_FROM_EMAIL="Cours particuliers <rappels@votre-domaine.tld>"
   supabase functions deploy send-session-reminders --no-verify-jwt
   ```

   Le secret `REMINDER_CRON_SECRET` doit être identique dans la configuration de la
   fonction et dans Vault. Ne l'ajoutez jamais au code du site. Dans le tableau de
   bord Supabase, activez les extensions `pg_cron`, `pg_net` et `supabase_vault`,
   puis exécutez dans le SQL Editor (en remplaçant les deux valeurs indiquées) :

   ```sql
   select vault.create_secret(
     'https://<project-ref>.supabase.co/functions/v1/send-session-reminders',
     'session-reminder-function-url'
   );
   select vault.create_secret('<secret-aleatoire>', 'session-reminder-cron-secret');

   select cron.schedule(
     'session-reminders-every-five-minutes',
     '*/5 * * * *',
     $$
     select net.http_post(
       url := (
         select decrypted_secret from vault.decrypted_secrets
         where name = 'session-reminder-function-url'
       ),
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-reminder-secret', (
           select decrypted_secret from vault.decrypted_secrets
           where name = 'session-reminder-cron-secret'
         )
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```

   La planification vérifie les rappels toutes les cinq minutes. Les séances déjà
   enregistrées sans heure ou sans adresse e-mail ne sont pas envoyées.

   ## Installation sur Android

   L'application est installable comme PWA depuis Chrome après publication des
fichiers `index.html`, `manifest.webmanifest`, `service-worker.js` et du dossier
`icons/`. Ouvrez l'URL GitHub Pages sur Android, puis choisissez **Installer
l'application** ou **Ajouter à l'écran d'accueil** dans le menu Chrome.
La page mise en cache peut s'ouvrir hors connexion, mais l'authentification et
la synchronisation Supabase nécessitent Internet.

## Données existantes

À la première connexion d'un compte dans un navigateur contenant les anciennes
données locales, l'application propose de les importer dans le compte connecté.
N'acceptez l'import que si ces données doivent appartenir à ce compte.
L'import XML/CSV reste disponible pour les transferts manuels.

## Sécurité et limites

- La base utilise Row Level Security : les requêtes sont limitées à l'identifiant
  du compte connecté et aux comptes approuvés.
- Les données de deux utilisateurs ne sont pas partagées. L'approbation du
  compte ne donne pas à l'administrateur accès à ses données.
- La clé publishable/anon n'est pas un secret ; les règles RLS constituent la
  frontière d'accès. Ne publiez jamais de clé `service_role`.
- Servez l'application en HTTPS avec GitHub Pages. Les données de cours et de
  paiement sont personnelles : vérifiez que Supabase et GitHub sont autorisés
  par votre organisation avant d'y enregistrer des données réelles.
- Les changements sont synchronisés vers Supabase après chaque opération. Une
  connexion Internet est nécessaire pour consulter et modifier les données.
