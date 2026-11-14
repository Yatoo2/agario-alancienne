const db = require("../sql.js");

// Enregistre le classement final d'un round
const saveRoundResults = (tournamentId, round, results) => {
    return new Promise((resolve) => {
        const now = Date.now();
        db.serialize(() => {
            const stmt = db.prepare(
                "INSERT INTO war_results (tournament_id, round, rank, name, mass, timestamp) VALUES (?, ?, ?, ?, ?, ?)"
            );
            for (const r of results) {
                stmt.run([tournamentId, round, r.rank, r.name, r.mass, now]);
            }
            stmt.finalize((err) => {
                if (err) console.error(err);
                resolve();
            });
        });
    });
};

// Toutes les lignes du dernier tournoi enregistré (pour reprendre après un redémarrage)
const loadLatestTournament = () => {
    return new Promise((resolve) => {
        db.get("SELECT MAX(tournament_id) AS id FROM war_results", [], (err, row) => {
            if (err || !row || row.id === null) {
                if (err) console.error(err);
                resolve(null);
                return;
            }
            db.all(
                "SELECT round, rank, name, mass FROM war_results WHERE tournament_id = ? ORDER BY round, rank",
                [row.id],
                (err2, rows) => {
                    if (err2) console.error(err2);
                    resolve({ id: row.id, rows: rows || [] });
                }
            );
        });
    });
};

module.exports = {
    saveRoundResults,
    loadLatestTournament,
};
