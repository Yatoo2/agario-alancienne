// Réglages du mode War modifiés depuis la page admin, enregistrés à côté de la base
// (donc dans le volume Docker) pour survivre aux redémarrages.
const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, '..', 'db', 'war-settings.json');

const load = () => {
    try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
        return {};
    }
};

const save = (settings) => {
    try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (err) {
        console.error('Impossible d\'enregistrer les réglages War', err);
    }
};

module.exports = { load, save };
