module.exports = {
    host: "0.0.0.0",
    port: 3000,
    logpath: "logger.php",
    foodMass: 1,
    fireFood: 20,
    limitSplit: 16,
    defaultPlayerMass: 10,
	virus: {
        fill: "#2a0f4a",
        stroke: "#ff2aa1",
        strokeWidth: 20,
        defaultMass: {
            from: 100,
            to: 150
        },
        splitMass: 180,
        uniformDisposition: false,
	},
    gameWidth: 5000,
    gameHeight: 5000,
    adminPass: "DEFAULT",
    // Mode War (tournoi) : durées en secondes
    // (modifiables sans rebuild via les variables d'environnement WAR_*)
    war: {
        rounds: Number(process.env.WAR_ROUNDS) || 3,
        roundSeconds: Number(process.env.WAR_ROUND_SECONDS) || 15 * 60,
        warmupSeconds: Number(process.env.WAR_WARMUP_SECONDS) || 30,
        pauseSeconds: Number(process.env.WAR_PAUSE_SECONDS) || 5 * 60
    },
    gameMass: 20000,
    maxFood: 1000,
    maxVirus: 50,
    slowBase: 4.5,
    logChat: 0,
    networkUpdateFactor: 40,
    maxHeartbeatInterval: 5000,
    foodUniformDisposition: true,
    newPlayerInitialPosition: "farthest",
    massLossRate: 1,
    minMassLoss: 50,
    sqlinfo: {
      fileName: "db.sqlite3",
    }
};
