# Changelog - Corrections des problèmes de déploiement

## Version 2.1.0 - Correctifs critiques pour Render

### 🔧 Corrections majeures

#### 1. Résolution du conflit Telegram 409
**Problème:** Le bot générait des erreurs `409 Conflict` sur Render car plusieurs instances essayaient de faire du polling simultanément.

**Solution:**
- Ajout du support des webhooks pour les environnements de production
- Le bot détecte automatiquement s'il tourne sur Render (via la variable `PORT`)
- En production: utilise des webhooks (pas de conflit)
- En développement: utilise le polling (plus simple pour tester)

**Configuration requise sur Render:**
```env
WEBHOOK_URL=https://myplexmonitor.onrender.com
```

#### 2. Correction de l'adresse qBittorrent
**Problème:** qBittorrent utilisait `localhost:8080` au lieu de l'adresse IP du serveur, empêchant toute connexion depuis Render.

**Solution:**
- Amélioration de la logique de fallback pour `QBITTORRENT_HOST`
- Ordre de priorité: `QBITTORRENT_HOST` → `SERVER_IP` → `PLEX_IP` → `IP_SERVER` → `localhost`
- Si `SERVER_IP` est défini, qBittorrent l'utilise automatiquement

**Configuration requise sur Render:**
```env
SERVER_IP=51.154.46.41  # CRITIQUE!
```

#### 3. Amélioration des messages d'erreur
**Problème:** Les erreurs étaient vagues ("Error") sans indication de la cause.

**Solution:**
- Messages d'erreur détaillés pour qBittorrent:
  - `ECONNREFUSED`: Connexion refusée (serveur inaccessible)
  - `ETIMEDOUT`: Timeout (serveur ne répond pas)
  - Erreurs d'authentification explicites
- Messages d'erreur détaillés pour Telegram:
  - Explication claire du conflit 409
  - Solution suggérée directement dans les logs

#### 4. Validation de configuration au démarrage
**Problème:** Le bot démarrait même avec une configuration incorrecte, causant des erreurs en cascade.

**Solution:**
- Nouvelle fonction `validateConfig()` qui vérifie:
  - Variables obligatoires (`TELEGRAM_TOKEN`, `SERVER_IP`)
  - Variables recommandées (`PLEX_TOKEN`, `WEBHOOK_URL`)
  - Cohérence (si `SERVER_IP` est défini mais qBittorrent utilise localhost)
- Affichage clair des erreurs et avertissements au démarrage
- Tests de connexion Plex et qBittorrent au démarrage

### 🆕 Nouvelles fonctionnalités

#### Script de test de configuration
**Nouveau fichier:** `test-config.js`

Permet de tester la configuration AVANT de déployer sur Render:
```bash
npm run test-config
```

Vérifie:
- ✅ Toutes les variables d'environnement requises
- ✅ Connexion au serveur Plex (ping TCP)
- ✅ Connexion à qBittorrent (login WebUI)
- ✅ Authentification qBittorrent
- ✅ Cohérence de la configuration

#### Documentation complète
**Nouveaux fichiers:**
- `RENDER_SETUP.md`: Guide détaillé de configuration sur Render
- `TROUBLESHOOTING.md`: Guide de dépannage avec solutions pour chaque problème
- `.env.example`: Mis à jour avec `WEBHOOK_URL`

### 📝 Améliorations du code

#### Configuration
```javascript
// Avant
serverIp: process.env.SERVER_IP || process.env.PLEX_IP

// Après
serverIp: process.env.SERVER_IP || process.env.PLEX_IP || process.env.IP_SERVER
qbittorrent: {
    host: process.env.QBITTORRENT_HOST || process.env.SERVER_IP || process.env.PLEX_IP || process.env.IP_SERVER || "localhost",
}
```

#### Initialisation du bot
```javascript
// Avant
const bot = new TelegramBot(CONFIG.telegramToken, { polling: true });

// Après
const bot = CONFIG.isProduction && CONFIG.webhookUrl
    ? new TelegramBot(CONFIG.telegramToken, { webHook: true })
    : new TelegramBot(CONFIG.telegramToken, { polling: true });
```

#### Serveur Express
```javascript
// Ajout du support webhook
if (CONFIG.isProduction && CONFIG.webhookUrl) {
    const webhookPath = `/bot${CONFIG.telegramToken}`;
    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    bot.setWebHook(`${CONFIG.webhookUrl}${webhookPath}`);
}
```

### 🐛 Bugs corrigés

1. **Erreur 409 Telegram**: Conflit de polling résolu avec webhooks
2. **qBittorrent localhost**: Correction de la fallback vers SERVER_IP
3. **Messages d'erreur vagues**: Ajout de détails et suggestions
4. **Pas de validation**: Ajout de validateConfig() au démarrage
5. **Logs peu informatifs**: Amélioration des logs de démarrage

### 📋 Migration depuis v2.0.0

Si vous aviez déjà déployé la v2.0.0:

1. **Ajoutez ces variables sur Render:**
   ```env
   SERVER_IP=51.154.46.41
   WEBHOOK_URL=https://myplexmonitor.onrender.com
   ```

2. **Redéployez:**
   - Sur Render: Manual Deploy → Clear build cache & deploy

3. **Vérifiez les logs:**
   Vous devriez voir:
   ```
   ║  Mode: PRODUCTION
   ║  qBittorrent: 51.154.46.41:8080  (PAS localhost!)
   📡 Using Telegram webhooks (production mode)
   ✅ Webhook configured
   ✅ Connected to qBittorrent
   ✅ Plex server is reachable
   ```

### ⚙️ Variables d'environnement

#### Nouvelles variables
- `WEBHOOK_URL`: URL du webhook Telegram (production uniquement)

#### Variables modifiées
- `SERVER_IP`: Maintenant utilisée comme fallback pour `QBITTORRENT_HOST`

#### Variables inchangées
- Toutes les autres variables restent identiques

### 🧪 Tests effectués

- ✅ Démarrage avec configuration minimale
- ✅ Démarrage avec configuration complète
- ✅ Mode développement (polling)
- ✅ Mode production (webhooks)
- ✅ Connexion qBittorrent avec SERVER_IP
- ✅ Gestion d'erreurs réseau
- ✅ Validation de configuration

### 📚 Documentation

Nouveaux guides disponibles:
- [RENDER_SETUP.md](RENDER_SETUP.md): Configuration détaillée pour Render
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md): Résolution des problèmes courants
- README.md: Mis à jour avec section déploiement

### 🔜 Prochaines améliorations possibles

- [ ] Auto-détection du WEBHOOK_URL depuis Render
- [ ] Commande `/config` pour voir la configuration active
- [ ] Healthcheck automatique toutes les heures
- [ ] Notifications si qBittorrent/Plex deviennent inaccessibles
- [ ] Support de plusieurs serveurs Plex
- [ ] Interface web de configuration

---

**Note importante:** Cette version corrige tous les problèmes identifiés dans les logs Render. Le bot devrait maintenant fonctionner parfaitement avec la bonne configuration.
