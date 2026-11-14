/*jslint bitwise: true, node: true */
'use strict';

const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const SAT = require('sat');

const gameLogic = require('./game-logic');
const loggingRepositry = require('./repositories/logging-repository');
const chatRepository = require('./repositories/chat-repository');
const config = require('../../config');
const util = require('./lib/util');
const mapUtils = require('./map/map');
const {getPosition} = require("./lib/entityUtils");
const { Tournament } = require('./tournament');
const settingsStore = require('./repositories/settings-store');

let map = new mapUtils.Map(config);

let sockets = {};
let spectators = [];
// Tous les joueurs connectés avec un pseudo validé, vivants ou morts (pour le classement War)
let connectedPlayers = new Map();

// Mot de passe admin : variable d'environnement ADMIN_PASS prioritaire sur config.js
const ADMIN_PASS = process.env.ADMIN_PASS || config.adminPass;
if (ADMIN_PASS === 'DEFAULT') {
    console.warn('[ADMIN] Mot de passe admin par défaut ! Lance le conteneur avec -e ADMIN_PASS=...');
}
const INIT_MASS_LOG = util.mathLog(config.defaultPlayerMass, config.slowBase);

let leaderboard = [];
let leaderboardChanged = false;

const Vector = SAT.Vector;

app.use(express.static(__dirname + '/../client'));

const isNameTaken = (name, exceptId) => {
    const lower = name.toLowerCase();
    for (const [id, player] of connectedPlayers) {
        if (id !== exceptId && player.name && player.name.toLowerCase() === lower) return true;
    }
    return false;
};

// Joueur déconnecté pendant le tournoi, dont la cellule est restée dans l'arène
const findDisconnected = (name) => {
    const lower = name.toLowerCase();
    return map.players.data.find(p => p.disconnected && p.name && p.name.toLowerCase() === lower);
};

const removeDisconnected = () => {
    map.players.data = map.players.data.filter(p => !p.disconnected);
};

// Raison du refus d'un pseudo, ou null s'il est accepté
const nameRefusal = (name, exceptId, ipAddress) => {
    if (!util.validNick(name)) return 'Pseudo invalide.';
    if (tournament.isWar() && name.length === 0) return 'Pseudo obligatoire en mode War.';
    if (tournament.isWar() && isNameTaken(name, exceptId)) return 'Pseudo déjà pris, choisis-en un autre.';
    const ghost = name.length ? findDisconnected(name) : null;
    if (ghost && ghost.ipAddress !== ipAddress) {
        return 'Pseudo réservé : ce joueur s\'est déconnecté et peut revenir depuis son PC.';
    }
    return null;
};

app.get('/api/name-check', (req, res) => {
    const name = String(req.query.name || '').substring(0, 25);
    const reason = nameRefusal(name, null, req.socket.remoteAddress);
    res.json({ ok: reason === null, reason, mode: tournament.mode });
});

// Classement complet : joueurs connectés (les morts comptent pour 0)
// + joueurs déconnectés dont la cellule est toujours dans l'arène
const getRanking = () => {
    const alive = new Map(map.players.data.map(p => [p.id, p]));
    const ranking = Array.from(connectedPlayers.values())
        .map(p => ({
            id: p.id,
            name: p.name,
            mass: alive.has(p.id) ? Math.round(alive.get(p.id).massTotal) : 0,
            alive: alive.has(p.id),
            disconnected: false
        }));
    for (const p of map.players.data) {
        if (p.disconnected) {
            ranking.push({ id: p.id, name: p.name, mass: Math.round(p.massTotal), alive: true, disconnected: true });
        }
    }
    return ranking.sort((a, b) => b.mass - a.mass);
};

// Début de round : les déconnectés sortent, les autres repartent de la masse de base
// sur des positions réparties ; protection au départ du live
const resetArena = (protect) => {
    removeDisconnected();
    const protectedUntil = protect ? Date.now() + tournament.spawnProtectionMs() : 0;
    for (const player of map.players.data) {
        player.init(generateSpawnpoint(), config.defaultPlayerMass);
        player.protectedUntil = protectedUntil;
    }
    map.massFood.data = [];
};

const warSettings = Object.assign({ spawnProtectionSeconds: 5 }, config.war, settingsStore.load());

const tournament = new Tournament(warSettings, {
    getRanking,
    resetArena,
    saveSettings: settingsStore.save,
    onChange: () => {
        io.emit('warState', tournament.publicState());
        leaderboardChanged = true;
        sendAdminState();
    }
});

const sendAdminState = () => {
    io.to('admins').emit('adminState', Object.assign(tournament.adminState(), {
        ranking: getRanking(),
        defaultPassword: ADMIN_PASS === 'DEFAULT'
    }));
};

io.on('connection', function (socket) {
    let type = socket.handshake.query.type;
    console.log('User has connected: ', type);
    switch (type) {
        case 'player':
            addPlayer(socket);
            break;
        case 'spectator':
            addSpectator(socket);
            break;
        case 'admin':
            addAdmin(socket);
            break;
        default:
            console.log('Unknown user type, not doing anything.');
    }
});

function generateSpawnpoint() {
    let radius = util.massToRadius(config.defaultPlayerMass);
    return getPosition(config.newPlayerInitialPosition === 'farthest', radius, map.players.data)
}


const addPlayer = (socket) => {
    var currentPlayer = new mapUtils.playerUtils.Player(socket.id);
    currentPlayer.ipAddress = socket.handshake.address;

    socket.on('gotit', function (clientPlayerData) {
        console.log('[INFO] Player ' + clientPlayerData.name + ' connecting!');
        currentPlayer.init(generateSpawnpoint(), config.defaultPlayerMass);

        if (map.players.findIndexByID(socket.id) > -1) {
            console.log('[INFO] Player ID is already connected, kicking.');
            socket.disconnect();
        } else if (nameRefusal(String(clientPlayerData.name), socket.id, currentPlayer.ipAddress)) {
            socket.emit('kick', nameRefusal(String(clientPlayerData.name), socket.id, currentPlayer.ipAddress));
            socket.disconnect();
        } else {
            console.log('[INFO] Player ' + clientPlayerData.name + ' connected!');
            sockets[socket.id] = socket;

            const sanitizedName = clientPlayerData.name.replace(/(<([^>]+)>)/ig, '');
            clientPlayerData.name = sanitizedName;

            currentPlayer.clientProvidedData(clientPlayerData);

            // Retour d'un joueur déconnecté pendant le tournoi : il récupère sa cellule
            const ghost = findDisconnected(currentPlayer.name);
            if (ghost) {
                currentPlayer.cells = ghost.cells;
                currentPlayer.massTotal = ghost.massTotal;
                currentPlayer.x = ghost.x;
                currentPlayer.y = ghost.y;
                currentPlayer.hue = ghost.hue;
                currentPlayer.timeToMerge = ghost.timeToMerge;
                currentPlayer.protectedUntil = ghost.protectedUntil;
                map.players.removePlayerByID(ghost.id);
                console.log('[WAR] ' + currentPlayer.name + ' est revenu et récupère sa cellule (' + Math.round(ghost.massTotal) + ').');
            } else {
                currentPlayer.protectedUntil = Date.now() + tournament.spawnProtectionMs();
            }
            map.players.pushNew(currentPlayer);
            connectedPlayers.set(socket.id, currentPlayer);
            socket.emit('warState', tournament.publicState());
            io.emit('playerJoin', { name: currentPlayer.name });
            console.log('Total players: ' + map.players.data.length);
        }

    });

    socket.on('pingcheck', () => {
        socket.emit('pongcheck');
    });

    socket.on('windowResized', (data) => {
        currentPlayer.screenWidth = data.screenWidth;
        currentPlayer.screenHeight = data.screenHeight;
    });

    socket.on('respawn', () => {
        map.players.removePlayerByID(currentPlayer.id);
        socket.emit('welcome', currentPlayer, {
            width: config.gameWidth,
            height: config.gameHeight
        });
        console.log('[INFO] User ' + currentPlayer.name + ' has respawned');
    });

    socket.on('disconnect', () => {
        if (tournament.keepDisconnected() && currentPlayer.name && map.players.findIndexByID(currentPlayer.id) > -1) {
            // La cellule reste en place (et peut être mangée) en attendant son retour
            currentPlayer.disconnected = true;
            currentPlayer.target = { x: 0, y: 0 };
        } else {
            map.players.removePlayerByID(currentPlayer.id);
        }
        connectedPlayers.delete(socket.id);
        console.log('[INFO] User ' + currentPlayer.name + ' has disconnected');
        socket.broadcast.emit('playerDisconnect', { name: currentPlayer.name });
    });

    socket.on('playerChat', (data) => {
        var _sender = data.sender.replace(/(<([^>]+)>)/ig, '');
        var _message = data.message.replace(/(<([^>]+)>)/ig, '');

        if (config.logChat === 1) {
            console.log('[CHAT] [' + (new Date()).getHours() + ':' + (new Date()).getMinutes() + '] ' + _sender + ': ' + _message);
        }

        socket.broadcast.emit('serverSendPlayerChat', {
            sender: currentPlayer.name,
            message: _message.substring(0, 35)
        });

        chatRepository.logChatMessage(_sender, _message, currentPlayer.ipAddress)
            .catch((err) => console.error("Error when attempting to log chat message", err));
    });

    socket.on('pass', async (data) => {
        const password = data[0];
        if (password === ADMIN_PASS) {
            console.log('[ADMIN] ' + currentPlayer.name + ' just logged in as an admin.');
            socket.emit('serverMSG', 'Welcome back ' + currentPlayer.name);
            socket.broadcast.emit('serverMSG', currentPlayer.name + ' just logged in as an admin.');
            currentPlayer.admin = true;
        } else {
            console.log('[ADMIN] ' + currentPlayer.name + ' attempted to log in with the incorrect password: ' + password);

            socket.emit('serverMSG', 'Password incorrect, attempt logged.');

            loggingRepositry.logFailedLoginAttempt(currentPlayer.name, currentPlayer.ipAddress)
                .catch((err) => console.error("Error when attempting to log failed login attempt", err));
        }
    });

    socket.on('kick', (data) => {
        if (!currentPlayer.admin) {
            socket.emit('serverMSG', 'You are not permitted to use this command.');
            return;
        }

        var reason = '';
        var worked = false;
        for (let playerIndex in map.players.data) {
            let player = map.players.data[playerIndex];
            if (player.name === data[0] && !player.admin && !worked) {
                if (data.length > 1) {
                    for (var f = 1; f < data.length; f++) {
                        if (f === data.length) {
                            reason = reason + data[f];
                        }
                        else {
                            reason = reason + data[f] + ' ';
                        }
                    }
                }
                if (reason !== '') {
                    console.log('[ADMIN] User ' + player.name + ' kicked successfully by ' + currentPlayer.name + ' for reason ' + reason);
                }
                else {
                    console.log('[ADMIN] User ' + player.name + ' kicked successfully by ' + currentPlayer.name);
                }
                socket.emit('serverMSG', 'User ' + player.name + ' was kicked by ' + currentPlayer.name);
                sockets[player.id].emit('kick', reason);
                sockets[player.id].disconnect();
                map.players.removePlayerByIndex(playerIndex);
                worked = true;
            }
        }
        if (!worked) {
            socket.emit('serverMSG', 'Could not locate user or user is an admin.');
        }
    });

    // Heartbeat function, update everytime.
    socket.on('0', (target) => {
        currentPlayer.lastHeartbeat = new Date().getTime();
        if (target.x !== currentPlayer.x || target.y !== currentPlayer.y) {
            currentPlayer.target = target;
        }
    });

    socket.on('1', function () {
        if (!tournament.canEat()) return;
        // Fire food.
        const minCellMass = config.defaultPlayerMass + config.fireFood;
        for (let i = 0; i < currentPlayer.cells.length; i++) {
            if (currentPlayer.cells[i].mass >= minCellMass) {
                currentPlayer.changeCellMass(i, -config.fireFood);
                map.massFood.addNew(currentPlayer, i, config.fireFood);
            }
        }
    });

    socket.on('2', () => {
        if (!tournament.canEat()) return;
        currentPlayer.userSplit(config.limitSplit, config.defaultPlayerMass);
    });
}

const addSpectator = (socket) => {
    socket.on('gotit', function () {
        sockets[socket.id] = socket;
        spectators.push(socket.id);
        io.emit('playerJoin', { name: '' });
    });

    socket.emit("welcome", {}, {
        width: config.gameWidth,
        height: config.gameHeight
    });
    socket.emit('warState', tournament.publicState());
    socket.on('disconnect', () => {
        spectators = spectators.filter(id => id !== socket.id);
        delete sockets[socket.id];
    });
}

// Page /admin.html : pilotage des modes et du tournoi
const addAdmin = (socket) => {
    let authorized = false;

    socket.on('adminAuth', (password) => {
        if (password === ADMIN_PASS) {
            authorized = true;
            socket.join('admins');
            socket.emit('adminAuthOk');
            console.log('[ADMIN] Connexion à la page admin depuis ' + socket.handshake.address);
            sendAdminState();
        } else {
            socket.emit('adminAuthFail');
            console.log('[ADMIN] Mot de passe incorrect sur la page admin depuis ' + socket.handshake.address);
            loggingRepositry.logFailedLoginAttempt('admin-page', socket.handshake.address)
                .catch((err) => console.error("Error when attempting to log failed login attempt", err));
        }
    });

    socket.on('adminCmd', async (cmd) => {
        if (!authorized || !cmd) return;
        let error = null;
        switch (cmd.action) {
            case 'mode': error = tournament.setMode(cmd.mode); break;
            case 'start': error = tournament.start(); break;
            case 'resume': error = await tournament.resume(); break;
            case 'skip': error = tournament.skip(); break;
            case 'extend': error = tournament.extend(Number(cmd.seconds) || 60); break;
            case 'stop': error = tournament.stop(); break;
            case 'settings': error = tournament.updateSettings(cmd.settings || {}); break;
            default: error = 'Commande inconnue.';
        }
        console.log('[ADMIN] Commande ' + cmd.action + (error ? ' refusée : ' + error : ' exécutée'));
        socket.emit('adminResult', { action: cmd.action, error });
        sendAdminState();
    });
}

const tickPlayer = (currentPlayer) => {
    if (!currentPlayer.disconnected && currentPlayer.lastHeartbeat < new Date().getTime() - config.maxHeartbeatInterval) {
        sockets[currentPlayer.id].emit('kick', 'Last heartbeat received over ' + config.maxHeartbeatInterval + ' ago.');
        sockets[currentPlayer.id].disconnect();
    }

    currentPlayer.move(config.slowBase, config.gameWidth, config.gameHeight, INIT_MASS_LOG);

    // Phase « pas live » du mode War : on bouge, mais on ne mange rien
    if (!tournament.canEat()) return;

    const isEntityInsideCircle = (point, circle) => {
        return SAT.pointInCircle(new Vector(point.x, point.y), circle);
    };

    const canEatMass = (cell, cellCircle, cellIndex, mass) => {
        if (isEntityInsideCircle(mass, cellCircle)) {
            if (mass.id === currentPlayer.id && mass.speed > 0 && cellIndex === mass.num)
                return false;
            if (cell.mass > mass.mass * 1.1)
                return true;
        }

        return false;
    };

    const canEatVirus = (cell, cellCircle, virus) => {
        return virus.mass < cell.mass && isEntityInsideCircle(virus, cellCircle)
    }

    const cellsToSplit = [];
    for (let cellIndex = 0; cellIndex < currentPlayer.cells.length; cellIndex++) {
        const currentCell = currentPlayer.cells[cellIndex];

        const cellCircle = currentCell.toCircle();

        const eatenFoodIndexes = util.getIndexes(map.food.data, food => isEntityInsideCircle(food, cellCircle));
        const eatenMassIndexes = util.getIndexes(map.massFood.data, mass => canEatMass(currentCell, cellCircle, cellIndex, mass));
        const eatenVirusIndexes = util.getIndexes(map.viruses.data, virus => canEatVirus(currentCell, cellCircle, virus));

        if (eatenVirusIndexes.length > 0) {
            cellsToSplit.push(cellIndex);
            map.viruses.delete(eatenVirusIndexes)
        }

        let massGained = eatenMassIndexes.reduce((acc, index) => acc + map.massFood.data[index].mass, 0);

        map.food.delete(eatenFoodIndexes);
        map.massFood.remove(eatenMassIndexes);
        massGained += (eatenFoodIndexes.length * config.foodMass);
        currentPlayer.changeCellMass(cellIndex, massGained);
    }
    currentPlayer.virusSplit(cellsToSplit, config.limitSplit, config.defaultPlayerMass);
};

const tickGame = () => {
    // Fin de round / pause : le monde est figé
    if (tournament.isFrozen()) return;

    map.players.data.forEach(tickPlayer);
    map.massFood.move(config.gameWidth, config.gameHeight);

    if (!tournament.canEat()) return;

    map.players.handleCollisions(function (gotEaten, eater) {
        const cellGotEaten = map.players.getCell(gotEaten.playerIndex, gotEaten.cellIndex);

        map.players.data[eater.playerIndex].changeCellMass(eater.cellIndex, cellGotEaten.mass);

        const playerDied = map.players.removeCell(gotEaten.playerIndex, gotEaten.cellIndex);
        if (playerDied) {
            let playerGotEaten = map.players.data[gotEaten.playerIndex];
            io.emit('playerDied', { name: playerGotEaten.name }); //TODO: on client it is `playerEatenName` instead of `name`
            sockets[playerGotEaten.id].emit('RIP');
            map.players.removePlayerByIndex(gotEaten.playerIndex);
        }
    });

};

const calculateLeaderboard = () => {
    const topPlayers = map.players.getTopPlayers();

    if (leaderboard.length !== topPlayers.length) {
        leaderboard = topPlayers;
        leaderboardChanged = true;
    } else {
        for (let i = 0; i < leaderboard.length; i++) {
            if (leaderboard[i].id !== topPlayers[i].id) {
                leaderboard = topPlayers;
                leaderboardChanged = true;
                break;
            }
        }
    }
}

const gameloop = () => {
    tournament.tick();
    if (!tournament.keepDisconnected()) removeDisconnected();

    if (map.players.data.length > 0) {
        calculateLeaderboard();
        if (tournament.canEat() && !tournament.isFrozen()) {
            map.players.shrinkCells(config.massLossRate, config.defaultPlayerMass, config.minMassLoss);
        }
    }

    // Mode War : chrono et classement complet envoyés à tous chaque seconde
    if (tournament.isWar()) {
        io.emit('warState', tournament.publicState());
        io.emit('leaderboard', { mode: 'war', players: connectedPlayers.size, leaderboard: getRanking() });
    }
    sendAdminState();

    map.balanceMass(config.foodMass, config.gameMass, config.maxFood, config.maxVirus);
};

const sendUpdates = () => {
    spectators.forEach(updateSpectator);
    map.enumerateWhatPlayersSee(function (playerData, visiblePlayers, visibleFood, visibleMass, visibleViruses) {
        sockets[playerData.id].emit('serverTellPlayerMove', playerData, visiblePlayers, visibleFood, visibleMass, visibleViruses);
        if (leaderboardChanged && !tournament.isWar()) {
            sendLeaderboard(sockets[playerData.id]);
        }
    });

    leaderboardChanged = false;
};

const sendLeaderboard = (socket) => {
    socket.emit('leaderboard', {
        mode: 'ffa',
        players: map.players.data.length,
        leaderboard
    });
}
const updateSpectator = (socketID) => {
    let playerData = {
        x: config.gameWidth / 2,
        y: config.gameHeight / 2,
        cells: [],
        massTotal: 0,
        hue: 100,
        id: socketID,
        name: ''
    };
    sockets[socketID].emit('serverTellPlayerMove', playerData, map.players.data, map.food.data, map.massFood.data, map.viruses.data);
    if (leaderboardChanged && !tournament.isWar()) {
        sendLeaderboard(sockets[socketID]);
    }
}

setInterval(tickGame, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / config.networkUpdateFactor);

// Don't touch, IP configurations.
var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || config.host;
var serverport = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || config.port;
http.listen(serverport, ipaddress, () => console.log('[DEBUG] Listening on ' + ipaddress + ':' + serverport));
