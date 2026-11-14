// Interface du mode War : bandeau de chrono, classement complet, résultats de round.

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'
}[c]));

const displayName = (name) => (name && name.length ? escapeHtml(name) : 'Cellule anonyme');

const formatTime = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
};

const state = {
    war: { mode: 'ffa', phase: 'idle' },
    endsAt: null,          // horloge locale
    fullBoard: true,       // Tab bascule classement complet / top 10
    lastBoard: null,
    playerId: null,
    myName: null,
    resultsKey: null,      // évite de reconstruire l'écran de résultats chaque seconde
    dismissedKey: null,
    lastPhaseKey: null,
    goUntil: 0,
    onPhaseChange: null
};

const el = (id) => document.getElementById(id);

// ── Classement ──────────────────────────────────────────────────────────────
const renderFfaBoard = (list, playerId) => {
    let html = '<span class="title">Classement</span>';
    list.forEach((p, i) => {
        const line = (i + 1) + '. ' + displayName(p.name);
        html += '<br />' + (p.id == playerId ? '<span class="me">' + line + '</span>' : line);
    });
    return html;
};

const renderWarBoard = (list, playerId) => {
    let shown = list;
    if (!state.fullBoard) {
        // Version compacte : top 10 + ma ligne
        shown = list.slice(0, 10);
        const myIndex = list.findIndex(p => p.id == playerId);
        if (myIndex >= 10) shown = shown.concat([list[myIndex]]);
    }
    const rowsFit = Math.max(8, Math.floor((window.innerHeight * 0.6) / 19));
    const cols = Math.max(1, Math.ceil(shown.length / rowsFit));
    const rows = Math.max(1, Math.ceil(shown.length / cols));

    let html = '<span class="title">Classement</span>' +
        '<span class="hint">' + list.length + ' joueurs · Tab : ' + (state.fullBoard ? 'réduire' : 'tout voir') + '</span>' +
        '<ol class="war-list" style="grid-template-rows: repeat(' + rows + ', auto)">';
    for (const p of shown) {
        const rank = list.indexOf(p) + 1;
        const classes = [];
        if (p.id == playerId) classes.push('me');
        if (!p.alive || p.disconnected) classes.push('dead');
        html += '<li class="' + classes.join(' ') + '">' +
            '<span class="rank">' + rank + '.</span>' +
            '<span class="name">' + displayName(p.name) + (p.disconnected ? ' (déco)' : '') + '</span>' +
            '<span class="mass">' + p.mass + '</span></li>';
    }
    return html + '</ol>';
};

const renderLeaderboard = (data, playerId, myName) => {
    state.lastBoard = data;
    state.playerId = playerId;
    if (myName !== undefined) state.myName = myName;
    const status = el('status');
    status.classList.toggle('war', data.mode === 'war');
    status.innerHTML = data.mode === 'war'
        ? renderWarBoard(data.leaderboard, playerId)
        : renderFfaBoard(data.leaderboard, playerId);
};

// ── Bandeau et compte à rebours ─────────────────────────────────────────────
const bannerText = (remaining) => {
    const w = state.war;
    const round = 'ROUND ' + w.round + '/' + w.rounds;
    switch (w.phase) {
        case 'idle': return 'MODE WAR · en attente du lancement du tournoi';
        case 'warmup': return round + ' · PAS LIVE · départ dans ' + formatTime(remaining);
        case 'live': return round + ' · LIVE · ' + formatTime(remaining);
        case 'pause': return 'PAUSE · round ' + (w.round + 1) + ' dans ' + formatTime(remaining);
        case 'finished': return 'TOURNOI TERMINÉ';
        default: return '';
    }
};

const updateBanner = () => {
    const banner = el('warBanner');
    const countdown = el('warCountdown');
    if (!banner) return;
    const w = state.war;
    if (w.mode !== 'war') {
        banner.className = 'hidden';
        countdown.className = 'hidden';
        return;
    }
    const remaining = state.endsAt ? state.endsAt - Date.now() : 0;
    banner.textContent = bannerText(remaining);
    banner.className = 'phase-' + w.phase + (w.phase === 'live' && remaining <= 60000 ? ' ending' : '');

    // Gros décompte 5-4-3-2-1 puis « GO ! »
    if (w.phase === 'warmup' && remaining <= 5000 && remaining > 0) {
        countdown.textContent = Math.ceil(remaining / 1000);
        countdown.className = '';
    } else if (Date.now() < state.goUntil) {
        countdown.textContent = 'GO !';
        countdown.className = 'go';
    } else {
        countdown.className = 'hidden';
    }
};

// ── Écran de résultats (pause et fin de tournoi) ────────────────────────────
const resultsTable = (title, headers, rows) => {
    let html = '<section><h3>' + title + '</h3><div class="table-wrap"><table><thead><tr>';
    html += headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
    html += rows.length ? rows.join('') : '<tr><td colspan="' + headers.length + '">Aucun joueur classé</td></tr>';
    return html + '</tbody></table></div></section>';
};

const renderResults = (w) => {
    const roundRows = (w.lastRoundResults || []).map(r =>
        '<tr' + (r.name && r.name === state.myName ? ' class="me"' : '') + '>' +
        '<td>' + r.rank + '</td><td>' + displayName(r.name) + '</td><td>' + r.mass + '</td></tr>');
    const roundHeaders = Array.from({ length: w.rounds }, (_, i) => 'R' + (i + 1));
    const standingRows = (w.standings || []).map((s, i) =>
        '<tr><td>' + (i + 1) + '</td><td>' + displayName(s.name) + '</td>' +
        s.rounds.map(m => '<td>' + m + '</td>').join('') +
        '<td class="total">' + s.total + '</td></tr>');

    const standingsTable = resultsTable('Cumul du tournoi', ['#', 'Joueur'].concat(roundHeaders, ['Total']), standingRows);
    const roundTable = resultsTable('Round ' + w.round, ['#', 'Joueur', 'Points'], roundRows);

    if (w.phase === 'finished') {
        const winner = w.standings && w.standings[0];
        el('warResultsTitle').innerHTML = winner
            ? '🏆 Vainqueur : <span>' + displayName(winner.name) + '</span> · ' + winner.total + ' pts'
            : 'Tournoi terminé';
        el('warResultsBody').innerHTML = standingsTable + roundTable;
    } else {
        el('warResultsTitle').innerHTML = 'Fin du round ' + w.round + '/' + w.rounds;
        el('warResultsBody').innerHTML = roundTable + standingsTable;
    }
};

const updateResults = () => {
    const w = state.war;
    const overlay = el('warResults');
    if (!overlay) return;
    const visible = w.mode === 'war' && (w.phase === 'pause' || w.phase === 'finished') && w.standings;
    if (!visible) {
        overlay.className = 'hidden';
        state.resultsKey = null;
        return;
    }
    const key = w.phase + ':' + w.round;
    if (state.resultsKey !== key) {
        renderResults(w);
        state.resultsKey = key;
    }
    overlay.className = state.dismissedKey === key ? 'hidden' : '';
};

const handleWarState = (w) => {
    const phaseKey = w.mode + ':' + w.phase + ':' + w.round;
    const previous = state.war;
    state.war = w;
    state.endsAt = w.remainingMs === null || w.remainingMs === undefined ? null : Date.now() + w.remainingMs;
    if (state.lastPhaseKey !== null && state.lastPhaseKey !== phaseKey) {
        if (w.phase === 'live' && previous.phase === 'warmup') state.goUntil = Date.now() + 1500;
        if (state.onPhaseChange) state.onPhaseChange(w, previous);
    }
    state.lastPhaseKey = phaseKey;
    updateBanner();
    updateResults();
};

const init = (options) => {
    state.onPhaseChange = options && options.onPhaseChange;
    setInterval(updateBanner, 200);

    el('warResultsClose').addEventListener('click', () => {
        state.dismissedKey = state.resultsKey;
        updateResults();
    });

    // Tab : classement complet / compact
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || state.war.mode !== 'war') return;
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        e.preventDefault();
        state.fullBoard = !state.fullBoard;
        if (state.lastBoard) renderLeaderboard(state.lastBoard, state.playerId);
    });
};

module.exports = { init, handleWarState, renderLeaderboard, formatTime };
