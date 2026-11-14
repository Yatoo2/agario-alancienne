'use strict';

// Gestion des modes FFA / War et du déroulement automatique d'un tournoi.
//
// Mode FFA  : partie sans fin, comportement d'origine.
// Mode War  : phases enchaînées automatiquement
//   idle     → en attente du lancement par l'admin (jeu libre, pas de points)
//   warmup   → « pas live » : les joueurs arrivent et bougent, mais personne ne mange
//   live     → round chronométré ; à la fin, la masse de chacun devient ses points
//   pause    → jeu figé, classement du round affiché à tous
//   finished → jeu figé, classement cumulé final affiché

const warRepository = require('./repositories/war-repository');

const PHASE = {
    IDLE: 'idle',
    WARMUP: 'warmup',
    LIVE: 'live',
    PAUSE: 'pause',
    FINISHED: 'finished'
};

class Tournament {
    /**
     * @param settings { rounds, roundSeconds, warmupSeconds, pauseSeconds }
     * @param hooks    { getRanking(): [{name, mass}], resetArena(): void, onChange(): void }
     */
    constructor(settings, hooks) {
        this.settings = settings;
        this.hooks = hooks;
        this.mode = 'ffa';
        this.phase = PHASE.IDLE;
        this.tournamentId = null;
        this.round = 0;
        this.phaseEndsAt = null;
        this.lastRoundResults = [];
        this.standings = new Map(); // nom → { name, rounds: [masse round 1, …], total }
    }

    isWar() {
        return this.mode === 'war';
    }

    // Le monde est figé (personne ne bouge)
    isFrozen() {
        return this.isWar() && (this.phase === PHASE.PAUSE || this.phase === PHASE.FINISHED);
    }

    // Les joueurs peuvent manger, se diviser, éjecter
    canEat() {
        return !this.isWar() || this.phase === PHASE.IDLE || this.phase === PHASE.LIVE;
    }

    isRunning() {
        return this.isWar() && this.phase !== PHASE.IDLE && this.phase !== PHASE.FINISHED;
    }

    setMode(mode) {
        if (mode !== 'ffa' && mode !== 'war') return 'Mode inconnu.';
        if (this.isRunning()) return 'Arrête le tournoi avant de changer de mode.';
        this.mode = mode;
        this.phase = PHASE.IDLE;
        this.phaseEndsAt = null;
        this.hooks.onChange();
        return null;
    }

    start() {
        if (!this.isWar()) return 'Passe d\'abord en mode War.';
        if (this.isRunning()) return 'Un tournoi est déjà en cours.';
        this.tournamentId = Date.now();
        this.round = 0;
        this.standings = new Map();
        this.lastRoundResults = [];
        this.startRound();
        return null;
    }

    // Reprend le dernier tournoi enregistré (après un redémarrage du serveur)
    async resume() {
        if (!this.isWar()) return 'Passe d\'abord en mode War.';
        if (this.isRunning()) return 'Un tournoi est déjà en cours.';
        const latest = await warRepository.loadLatestTournament();
        if (!latest) return 'Aucun tournoi enregistré.';

        this.tournamentId = latest.id;
        this.standings = new Map();
        this.round = 0;
        const byRound = {};
        for (const row of latest.rows) {
            this.addToStandings(row.name, row.round, row.mass);
            this.round = Math.max(this.round, row.round);
            (byRound[row.round] = byRound[row.round] || []).push(row);
        }
        this.lastRoundResults = byRound[this.round] || [];
        if (this.round >= this.settings.rounds) {
            this.phase = PHASE.FINISHED;
            this.phaseEndsAt = null;
            this.hooks.onChange();
            return null;
        }
        this.startRound();
        return null;
    }

    stop() {
        if (!this.isRunning()) return 'Aucun tournoi en cours.';
        this.phase = PHASE.IDLE;
        this.phaseEndsAt = null;
        this.hooks.onChange();
        return null;
    }

    // Passe immédiatement à la phase suivante
    skip() {
        if (!this.isRunning()) return 'Aucun tournoi en cours.';
        this.advance();
        return null;
    }

    extend(seconds) {
        if (!this.isRunning() || !this.phaseEndsAt) return 'Aucun chrono en cours.';
        this.phaseEndsAt = Math.max(Date.now(), this.phaseEndsAt + seconds * 1000);
        this.hooks.onChange();
        return null;
    }

    startRound() {
        this.round++;
        this.phase = PHASE.WARMUP;
        this.phaseEndsAt = Date.now() + this.settings.warmupSeconds * 1000;
        this.hooks.resetArena();
        this.hooks.onChange();
    }

    advance() {
        switch (this.phase) {
            case PHASE.WARMUP:
                // Départ : tout le monde repart de la masse de base, positions réparties
                this.hooks.resetArena();
                this.phase = PHASE.LIVE;
                this.phaseEndsAt = Date.now() + this.settings.roundSeconds * 1000;
                break;
            case PHASE.LIVE:
                this.endRound();
                break;
            case PHASE.PAUSE:
                this.startRound();
                return;
            default:
                return;
        }
        this.hooks.onChange();
    }

    endRound() {
        const ranking = this.hooks.getRanking().filter(p => p.name);
        this.lastRoundResults = ranking.map((p, i) => ({
            rank: i + 1,
            name: p.name,
            mass: Math.round(p.mass)
        }));
        for (const r of this.lastRoundResults) {
            this.addToStandings(r.name, this.round, r.mass);
        }
        warRepository.saveRoundResults(this.tournamentId, this.round, this.lastRoundResults)
            .catch((err) => console.error('Error when saving war results', err));
        console.log('[WAR] Round ' + this.round + ' terminé, ' + this.lastRoundResults.length + ' joueurs classés.');

        if (this.round >= this.settings.rounds) {
            this.phase = PHASE.FINISHED;
            this.phaseEndsAt = null;
        } else {
            this.phase = PHASE.PAUSE;
            this.phaseEndsAt = Date.now() + this.settings.pauseSeconds * 1000;
        }
    }

    addToStandings(name, round, mass) {
        const key = name.toLowerCase();
        let entry = this.standings.get(key);
        if (!entry) {
            entry = { name, rounds: [], total: 0 };
            this.standings.set(key, entry);
        }
        entry.rounds[round - 1] = (entry.rounds[round - 1] || 0) + mass;
        entry.total += mass;
    }

    getStandings() {
        const rounds = this.settings.rounds;
        return Array.from(this.standings.values())
            .map(e => ({
                name: e.name,
                total: e.total,
                rounds: Array.from({ length: rounds }, (_, i) => e.rounds[i] || 0)
            }))
            .sort((a, b) => b.total - a.total);
    }

    // Appelé chaque seconde
    tick() {
        if (this.isRunning() && this.phaseEndsAt && Date.now() >= this.phaseEndsAt) {
            this.advance();
        }
    }

    // État envoyé aux joueurs
    publicState() {
        const showResults = this.isFrozen();
        return {
            mode: this.mode,
            phase: this.phase,
            round: this.round,
            rounds: this.settings.rounds,
            remainingMs: this.phaseEndsAt ? Math.max(0, this.phaseEndsAt - Date.now()) : null,
            lastRoundResults: showResults ? this.lastRoundResults : null,
            standings: showResults ? this.getStandings() : null
        };
    }

    // État envoyé à la page admin
    adminState() {
        return Object.assign(this.publicState(), {
            lastRoundResults: this.lastRoundResults,
            standings: this.getStandings(),
            tournamentId: this.tournamentId,
            settings: this.settings
        });
    }
}

module.exports = { Tournament, PHASE };
