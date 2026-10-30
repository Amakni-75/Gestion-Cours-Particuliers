# Gestion des cours particuliers

Application statique publiée sur GitHub Pages, avec authentification et
synchronisation multi-appareils par compte via Supabase. Chaque compte ne peut
accéder qu'à ses propres élèves, matières, séances et échéances. Les
administrateurs approuvent ou refusent les nouvelles inscriptions depuis
l'application, mais n'ont pas accès aux données privées des comptes.

## Mise en service

1. Créez un projet Supabase et ouvrez son **SQL Editor**.
2. Exécutez le contenu de [`supabase_schema.sql`](./supabase_schema.sql).
3. Dans les paramètres d'authentification Supabase, activez les inscriptions
   par e-mail et configurez l'URL de votre site GitHub Pages comme URL du site
   et URL de redirection autorisée. Configurez la confirmation d'adresse e-mail
   selon les règles de votre organisation.
4. Dans **Project Settings > API**, copiez l'URL du projet et la clé
   **publishable** (ou l'ancienne clé `anon`) dans [`supabase-config.js`](./supabase-config.js).
   Cette clé est destinée au navigateur ; n'y mettez jamais la clé
   `service_role`.
5. Publiez `gestion_de_cours_particuliersV3.html` et `supabase-config.js` dans
   le dépôt GitHub, puis activez **Settings > Pages** sur la branche et le
   dossier souhaités. Les deux fichiers doivent être servis depuis le même
   dossier.
6. Créez le compte de l'administrateur depuis l'application et confirmez son
   adresse e-mail. Dans le SQL Editor Supabase, exécutez la requête de
   promotion commentée à la fin de `supabase_schema.sql`, en remplaçant
   l'adresse d'exemple par celle du compte administrateur.
7. Les utilisateurs créent leur compte depuis l'application, confirment leur
   e-mail si demandé, puis attendent l'approbation de l'administrateur.

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
