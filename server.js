// server.js (Node + Express + ws)
ws.on("message", (data) => {
let msg;
try {
msg = JSON.parse(data.toString());
} catch {
return;
}


const p = players.get(id);
if (!p) return;


if (msg.t === "hello") {
const nm = (msg.name || "").toString().slice(0, 16).trim();
if (nm) p.name = nm;
broadcast({ t: "lobby", ...lobbySnapshot() });
return;
}


if (msg.t === "start") {
if (id === hostId && phase === "lobby") {
startGame();
}
return;
}


if (msg.t === "input" && phase === "playing") {
// aimXNorm is inside their own segment [0..1]
const aimXNorm = Number(msg.aimXNorm);
p.aimX = Number.isFinite(aimXNorm) ? clamp(aimXNorm, 0, 1) : 0.5;
p.shooting = !!msg.shooting;
return;
}


if (msg.t === "pickUpgrade" && phase === "upgrades") {
const pickKey = (msg.key || "").toString();
const pickObj = upgradePicks.get(id);
if (!pickObj || pickObj.pickedKey) return;
if (!pickObj.options.some(o => o.key === pickKey)) return;


pickObj.pickedKey = pickKey;
applyUpgrade(p, pickKey);
safeSend(p.ws, { t: "picked", key: pickKey });
maybeEndUpgradePhase();
return;
}
});


ws.on("close", () => {
// In lobby: remove player.
// In game: baseline keeps segments locked, but player will just stop sending input.
if (phase === "lobby") {
players.delete(id);


if (hostId === id) {
hostId = players.size ? Array.from(players.keys())[0] : null;
}


recomputeWorld();
broadcast({ t: "lobby", ...lobbySnapshot() });
} else {
const p = players.get(id);
if (p) {
p.shooting = false;
}
}
});
});


// Tick loop
setInterval(() => {
tick();


// If not playing, still send lobby state occasionally so UI stays fresh.
if (phase === "lobby") {
broadcast({ t: "lobby", ...lobbySnapshot() });
}
}, 1000 / TICK_RATE);


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(`Server running on http://localhost:${PORT}`);
console.log(`WebSocket on ws://localhost:${PORT}/ws`);
});
