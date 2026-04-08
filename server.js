let failoverAttempts = {};
const MAX_FAILOVER_ATTEMPTS = 3;
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const path = require("path");

const app = express();

const PORT       = process.argv[2] || 4000;
const PUBLIC_URL = process.argv[3] || null;

function cleanUrl(url) {
    if (!url) return null;
    return url.trim().replace(/\/$/, "");
}

const WORKER_NAME = "Steedwar";
const WORKER_CODE = "55223025";
const id          = `worker-${WORKER_NAME}-${WORKER_CODE}`;

const PULSE_INTERVAL = 3000;  
const PULSE_TIMEOUT  = 8000;  

const CAPABILITIES = ["math_compute", "http_fetch", "power_compute"];

let currentLoad = 0.0;
let activeTasks = 0;
const taskHistory = []; 

let knownCoordinators = [];
let currentCoordinator = null;
let ws         = null;
let pulseTimer = null;
let isFailoverActive = false;

let lastMessageFromCoordinator = 0;
let zombieWatchdogTimer = null;

function resetZombieWatchdog() {
    lastMessageFromCoordinator = Date.now();
}

function startZombieWatchdog() {
    stopZombieWatchdog();
    lastMessageFromCoordinator = Date.now();
    zombieWatchdogTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const elapsed = Date.now() - lastMessageFromCoordinator;
        if (elapsed > PULSE_TIMEOUT) {
            logEvent(`Coordinador zombie detectado (sin respuesta por ${elapsed}ms) → forzando reconexión`, true);
            ws.terminate(); 
        }
    }, 2000); 
}

function stopZombieWatchdog() {
    if (zombieWatchdogTimer) {
        clearInterval(zombieWatchdogTimer);
        zombieWatchdogTimer = null;
    }
}

let registeredWithLeader = false;
let registerAckTimer = null;
const REGISTER_ACK_TIMEOUT = 5000; 

function waitForRegisterAck() {
    if (registerAckTimer) clearTimeout(registerAckTimer);
    registeredWithLeader = false;
    registerAckTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN && !registeredWithLeader) {
            registeredWithLeader = true;
            logEvent(`✅ Registro confirmado con líder (sin redirect en ${REGISTER_ACK_TIMEOUT}ms)`);
            workerState.registeredWithLeader = true;
        }
    }, REGISTER_ACK_TIMEOUT);
}

let workerState = {
    status:              "Sin coordinador",
    coordinatorStatus:   "Desconectado",
    lastHeartbeat:       null,
    registeredWithLeader: false
};

const coordinatorNames = {};
let   coordinatorCounter = 0;

function getCoordinatorName(url) {
    if (!url) return "Desconocido";
    if (!coordinatorNames[url]) {
        coordinatorCounter++;
        coordinatorNames[url] = `Coordinador ${coordinatorCounter}`;
    }
    return coordinatorNames[url];
}

const systemLogs = [];
const errorLogs  = [];

function logEvent(message, isError = false) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, message };
    if (isError) {
        console.error(`[${timestamp}] ❌ ${message}`);
        errorLogs.unshift(entry);
        if (errorLogs.length > 50) errorLogs.pop();
    } else {
        console.log(`[${timestamp}] ℹ️  ${message}`);
    }
    systemLogs.unshift(entry);
    if (systemLogs.length > 50) systemLogs.pop();
}

function connectToCoordinator(url) {
    const urlLimpia = cleanUrl(url);
    if (!urlLimpia) return;
    if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
        ws = null;
    }
    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
    stopZombieWatchdog();
    registeredWithLeader = false;
    workerState.registeredWithLeader = false;
    if (registerAckTimer) { clearTimeout(registerAckTimer); registerAckTimer = null; }

    currentCoordinator = url;
    getCoordinatorName(url);
    logEvent(`Conectando a ${url}...`);

    try { ws = new WebSocket(url); }
    catch (err) {
        logEvent(`No se pudo crear WebSocket: ${err.message}`, true);
        scheduleFailover();
        return;
    }

    ws.on("open", () => {
        logEvent(`Conectado a ${currentCoordinator}`);
        isFailoverActive = false;
        workerState.coordinatorStatus = "Conectado";
        workerState.status            = "Conectado";
        resetZombieWatchdog();
        startZombieWatchdog();
        setTimeout(() => {
            sendRegister();
            waitForRegisterAck(); 
            sendStatus();
            pulseTimer = setInterval(sendPulse, PULSE_INTERVAL);
            startPeerPolling();
        }, 300);
    });

    ws.on("message", (msg) => {
        resetZombieWatchdog();
        try {
            const data = JSON.parse(msg);
            logEvent(`← ${data.type}`);

            const rawBackups = [
                ...(Array.isArray(data.data?.backups)      ? data.data.backups      : []),
                ...(Array.isArray(data.backups)            ? data.backups           : []),
                ...(Array.isArray(data.data?.coordinators) ? data.data.coordinators : []),
                data.data?.leaderUrl,
                data.data?.backupUrl,
            ].filter(Boolean);
            let agregados = 0;
            rawBackups.forEach(b => {
                const bUrl = typeof b === 'string' ? b : b?.url;
                if (
                    bUrl &&
                    (bUrl.startsWith('wss://') || bUrl.startsWith('ws://')) &&
                    bUrl !== PUBLIC_URL &&
                    !knownCoordinators.includes(bUrl)
                ) {
                    knownCoordinators.push(bUrl);
                    getCoordinatorName(bUrl);
                    logEvent(`🔍 Backup descubierto: ${bUrl}`);
                    agregados++;
                }
            });
            if (agregados > 0) logEvent(`✅ ${agregados} backup(s) nuevos agregados`);

            switch (data.type) {
                case "unknown":
                    logEvent("Coordinador nos olvidó → re-registrando", true);
                    sendRegister();
                    waitForRegisterAck();
                    break;

                case "redirect":
                    
                    registeredWithLeader = false;
                    workerState.registeredWithLeader = false;
                    if (registerAckTimer) { clearTimeout(registerAckTimer); registerAckTimer = null; }
                    logEvent(`↪ Redirect recibido → buscando líder real`);
                    handleRedirect(data.data);
                    break;

                case "task-assign":
                    handleTaskAssign(data.data, currentCoordinator);
                    break;

                case "error":
                    logEvent(`Error del coordinador: ${data.data?.message}`, true);
                    break;

                
                case "registered":
                case "welcome":
                case "ack":
                    if (!registeredWithLeader) {
                        registeredWithLeader = true;
                        workerState.registeredWithLeader = true;
                        if (registerAckTimer) { clearTimeout(registerAckTimer); registerAckTimer = null; }
                        logEvent(`✅ Registro confirmado por el líder (${data.type})`);
                    }
                    break;
            }
        } catch (e) {
            logEvent(`Mensaje no parseable: ${msg}`, true);
        }
    });

    ws.on("close", () => {
        logEvent(`Conexión cerrada con ${currentCoordinator}`, true);
        workerState.coordinatorStatus = "Desconectado";
        registeredWithLeader = false;
        workerState.registeredWithLeader = false;
        if (registerAckTimer) { clearTimeout(registerAckTimer); registerAckTimer = null; }
        if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
        stopZombieWatchdog();
        stopPeerPolling();
        scheduleFailover();
    });

    ws.on("error", (err) => {
        logEvent(`Error WS: ${err.message}`, true);
        if (ws) {
            ws.terminate();
        }
    });
}

function sendRegister() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: "register",
        data: {
            id,
            url:          PUBLIC_URL,
            name:         WORKER_NAME,
            capabilities: CAPABILITIES
        }
    }));
    logEvent(`→ register (id: ${id}, caps: ${CAPABILITIES.join(", ")})`);
}

function sendPulse() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: "pulse",
        data: {
            id,
            load: currentLoad
        }
    }));
    workerState.lastHeartbeat = Date.now();
    logEvent(`→ pulse (load: ${(currentLoad * 100).toFixed(0)}%)`);
}

function sendStatus() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: "status",
        data: { id, status: workerState.status, url: PUBLIC_URL }
    }));
}

function sendDisconnect() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "disconnect", data: { id } }));
}

let peerPollingTimer = null;
async function pollCoordinatorForPeers() {
    if (!currentCoordinator || workerState.coordinatorStatus !== "Conectado") return;

    const httpBase = currentCoordinator
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://')
        .replace(/\/$/, '');

    const endpoints = [
        `${httpBase}/status`,
        `${httpBase}/backups`,
        `${httpBase}/coordinators`,
        `${httpBase}/info`,
    ];

    for (const ep of endpoints) {
        try {
            const ctrl = new AbortController();
            const timeout = setTimeout(() => ctrl.abort(), 3000);
            const res = await fetch(ep, { signal: ctrl.signal });
            clearTimeout(timeout);
            if (!res.ok) continue;

            const body = await res.json().catch(() => null);
            if (!body) continue;

            const rawCandidates = [
                ...(Array.isArray(body.backups)         ? body.backups         : []),
                ...(Array.isArray(body.coordinators)    ? body.coordinators    : []),
                ...(Array.isArray(body.knownPeers)      ? body.knownPeers      : []),
                body.leaderUrl,
                body.backupUrl,
                body.leader?.url,
                body.state?.leaderUrl,
            ].filter(Boolean);

            let found = 0;
            rawCandidates.forEach(entry => {
                
                let url = typeof entry === 'string' ? entry : entry?.url;
                if (!url) return;
                url = url
                    .replace(/^https:\/\//, 'wss://')
                    .replace(/^http:\/\//, 'ws://')
                    .replace(/\/$/, '');
                const isCoordinator = !url.includes('worker') &&
                    (url.startsWith('wss://') || url.startsWith('ws://'));

                if (isCoordinator && url !== PUBLIC_URL && !knownCoordinators.includes(url)) {
                    knownCoordinators.push(url);
                    getCoordinatorName(url);
                    logEvent(`🔍 Backup descubierto via HTTP (${ep}): ${url}`);
                    found++;
                }
            });

            if (found > 0) logEvent(`✅ ${found} backup(s) nuevos descubiertos`);

        } catch (e) {
            
        }
    }
}

function startPeerPolling() {
    if (peerPollingTimer) clearInterval(peerPollingTimer);
    pollCoordinatorForPeers();
    peerPollingTimer = setInterval(pollCoordinatorForPeers, 5000);
}

function stopPeerPolling() {
    if (peerPollingTimer) { clearInterval(peerPollingTimer); peerPollingTimer = null; }
}

function scheduleFailover() {
    if (isFailoverActive) return;
    isFailoverActive = true;
    workerState.status = "Failover";

    const validCandidates = knownCoordinators.filter(url =>
        (failoverAttempts[url] || 0) < MAX_FAILOVER_ATTEMPTS
    );

    if (validCandidates.length === 0) {
        logEvent("Todos los coordinadores fallaron. Reiniciando intentos en 8s...", true);
        setTimeout(() => {
            failoverAttempts = {};
            isFailoverActive = false;
            workerState.status = "Sin coordinador";
            if (knownCoordinators.length > 0) connectToCoordinator(knownCoordinators[0]);
        }, 8000);
        return;
    }

    const next = validCandidates[0];
    failoverAttempts[next] = (failoverAttempts[next] || 0) + 1;

    logEvent(`Failover → Intentando con ${next} (Intento ${failoverAttempts[next]})`, true);

    setTimeout(() => {
        isFailoverActive = false;
        connectToCoordinator(next);
    }, 2000);
}

function handleRedirect(data) {
    const leaderUrl = data?.leaderUrl || data?.url;
    if (!leaderUrl) { logEvent("redirect sin leaderUrl", true); return; }
    logEvent(`↪ Redirect → líder: ${leaderUrl}`);

    if (!knownCoordinators.includes(leaderUrl)) {
        knownCoordinators.unshift(leaderUrl);
    } else {
        knownCoordinators = [leaderUrl, ...knownCoordinators.filter(u => u !== leaderUrl)];
    }
    getCoordinatorName(leaderUrl);
    setTimeout(() => connectToCoordinator(leaderUrl), 500);
}

function updateLoad() {
    currentLoad = Math.min(activeTasks / 5, 1.0);
}

function sendTaskResult(taskId, status, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        logEvent(`No se pudo enviar task-result ${taskId}: WS cerrado`, true);
        return;
    }
    ws.send(JSON.stringify({
        type: "task-result",
        data: { taskId, status, ...payload }
    }));
    logEvent(`→ task-result ${taskId} | ${status}`);
}

async function executeMathCompute(payload) {
    const { operation, a, b } = payload;
    if (a === undefined || b === undefined || !operation)
        throw new Error("Faltan parámetros: operation, a, b");
    const numA = Number(a), numB = Number(b);
    if (isNaN(numA) || isNaN(numB))
        throw new Error("a y b deben ser números válidos");
    switch (operation) {
        case "add": return { result: numA + numB };
        case "sub": return { result: numA - numB };
        case "mul": return { result: numA * numB };
        case "div":
            if (numB === 0) throw new Error("División por cero no permitida");
            return { result: numA / numB };
        default:
            throw new Error(`Operación desconocida: '${operation}'. Usa: add, sub, mul, div`);
    }
}

async function executeHttpFetch(payload) {
    const { url } = payload;
    if (!url) throw new Error("Falta parámetro: url");
    const ctrl    = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timeout);
        const ct = res.headers.get("content-type") || "";
        let body;
        if (ct.includes("application/json")) {
            try { body = await res.json(); } catch { body = await res.text(); }
        } else {
            const text = await res.text();
            try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
        }
        return { status: res.status, body };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === "AbortError") throw new Error("Timeout: no respondió en 10s");
        throw new Error(`Error en http_fetch: ${err.message}`);
    }
}

async function executePowerCompute(payload) {
    const { base, exponent } = payload;
    if (base === undefined || exponent === undefined)
        throw new Error("Faltan parámetros: base, exponent");
    const numBase = Number(base), numExp = Number(exponent);
    if (isNaN(numBase) || isNaN(numExp))
        throw new Error("base y exponent deben ser números válidos");
    if (numBase === 0 && numExp < 0)
        throw new Error("0 elevado a exponente negativo no está definido");
    return { result: Math.pow(numBase, numExp) };
}

async function handleTaskAssign(data, coordinatorUrl) {
    const taskId   = data.taskId   || data.id;
    const taskType = data.type     || data.taskType || data.capability;
    const payload  = data.payload  || data.params   || data.data || {};
    
    if (!taskId || !taskType) { logEvent("task-assign incompleto, ignorando", true); return; }

    if (!CAPABILITIES.includes(taskType)) {
        logEvent(`Capacidad '${taskType}' no soportada`, true);
        sendTaskResult(taskId, "error", { error: `Este worker no soporta '${taskType}'` });
        return;
    }

    const coordName = getCoordinatorName(coordinatorUrl);
    logEvent(`⚙️ Tarea recibida de ${coordName} → ${taskId} (${taskType})`);

    activeTasks++;
    updateLoad();

    const entry = {
        taskId, type: taskType, payload: payload || {},
        status: "running", startedAt: Date.now(), finishedAt: null,
        result: null, error: null, coordinatorUrl, coordinatorName: coordName
    };
    taskHistory.unshift(entry);
    if (taskHistory.length > 50) taskHistory.pop();

    try {
        let result;
        switch (taskType) {
            case "math_compute":  result = await executeMathCompute(payload || {}); break;
            case "http_fetch":    result = await executeHttpFetch(payload || {}); break;
            case "power_compute": result = await executePowerCompute(payload || {}); break;
        }
        sendTaskResult(taskId, "ok", result);
        logEvent(`✅ ${taskId} completada → ${JSON.stringify(result)}`);
        entry.status = "ok";
        entry.result = result;
    } catch (err) {
        sendTaskResult(taskId, "error", { error: err.message });
        logEvent(`❌ ${taskId} falló: ${err.message}`, true);
        entry.status = "error";
        entry.error  = err.message;
    } finally {
        entry.finishedAt = Date.now();
        activeTasks = Math.max(0, activeTasks - 1);
        updateLoad();
    }
}

async function executeTaskLocally(taskType, payload) {
    if (!CAPABILITIES.includes(taskType)) {
        throw new Error(`Capacidad '${taskType}' no soportada por este worker`);
    }
    switch (taskType) {
        case "math_compute":  return await executeMathCompute(payload || {});
        case "http_fetch":    return await executeHttpFetch(payload || {});
        case "power_compute": return await executePowerCompute(payload || {});
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/connect", (req, res) => {
    const { coordinatorUrl } = req.body;
    if (!coordinatorUrl) return res.status(400).json({ error: "Falta coordinatorUrl" });

    if (!knownCoordinators.includes(coordinatorUrl))
        knownCoordinators.unshift(coordinatorUrl);
    else
        knownCoordinators = [coordinatorUrl, ...knownCoordinators.filter(u => u !== coordinatorUrl)];

    getCoordinatorName(coordinatorUrl);
    logEvent(`Conexión iniciada → ${coordinatorUrl}`);
    connectToCoordinator(coordinatorUrl);
    res.json({ message: "Conectando..." });
});

app.post("/change-coordinator", (req, res) => {
    const { newCoordinatorUrl } = req.body;
    if (!newCoordinatorUrl) return res.status(400).json({ error: "Falta newCoordinatorUrl" });
    if (!knownCoordinators.includes(newCoordinatorUrl)) {
        knownCoordinators.push(newCoordinatorUrl);
        getCoordinatorName(newCoordinatorUrl);
    }
    logEvent(`Cambio manual → ${newCoordinatorUrl}`);
    connectToCoordinator(newCoordinatorUrl);
    res.json({ message: "Cambiando..." });
});

app.post("/add-backup", (req, res) => {
    const { backupUrl } = req.body;
    if (!backupUrl) return res.status(400).json({ error: "Falta backupUrl" });
    if (!knownCoordinators.includes(backupUrl)) {
        knownCoordinators.push(backupUrl);
        getCoordinatorName(backupUrl);
        logEvent(`Backup agregado: ${backupUrl}`);
    }
    res.json({ message: "Backup guardado" });
});

app.post("/remove-backup", (req, res) => {
    const { urlToRemove } = req.body;
    knownCoordinators = knownCoordinators.filter(u => u !== urlToRemove);
    logEvent(`Backup eliminado: ${urlToRemove}`);
    if (urlToRemove === currentCoordinator) {
        if (knownCoordinators.length > 0) scheduleFailover();
        else {
            if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
            stopZombieWatchdog();
            currentCoordinator = null;
            workerState.status = "Sin coordinador";
            workerState.coordinatorStatus = "Desconectado";
        }
    }
    res.json({ message: "Eliminado" });
});

app.post("/reorder-backup", (req, res) => {
    const { urlToMove, direction } = req.body;
    const i = knownCoordinators.indexOf(urlToMove);
    if (i === -1) return res.status(404).json({ error: "No encontrado" });
    if (direction === "up" && i > 0)
        [knownCoordinators[i - 1], knownCoordinators[i]] = [knownCoordinators[i], knownCoordinators[i - 1]];
    else if (direction === "down" && i < knownCoordinators.length - 1)
        [knownCoordinators[i + 1], knownCoordinators[i]] = [knownCoordinators[i], knownCoordinators[i + 1]];
    res.json({ message: "Reordenado" });
});

app.post("/disconnect", (req, res) => {
    sendDisconnect();
    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
    stopZombieWatchdog();
    if (registerAckTimer) { clearTimeout(registerAckTimer); registerAckTimer = null; }
    if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
    currentCoordinator = null;
    registeredWithLeader = false;
    workerState.status = "Sin coordinador";
    workerState.coordinatorStatus = "Desconectado";
    workerState.registeredWithLeader = false;
    logEvent("Worker desconectado manualmente");
    res.json({ message: "Detenido" });
});
app.post("/send-task", async (req, res) => {
    const { type: taskType, payload } = req.body;
    if (!taskType) return res.status(400).json({ error: "Falta el campo 'type'" });
    if (!CAPABILITIES.includes(taskType)) {
        return res.status(400).json({ error: `Capacidad '${taskType}' no soportada. Disponibles: ${CAPABILITIES.join(", ")}` });
    }

    const taskId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    logEvent(`⚙️ Tarea manual enviada → ${taskId} (${taskType})`);

    activeTasks++;
    updateLoad();

    const entry = {
        taskId, type: taskType, payload: payload || {},
        status: "running", startedAt: Date.now(), finishedAt: null,
        result: null, error: null,
        coordinatorUrl: currentCoordinator || "manual",
        coordinatorName: currentCoordinator ? getCoordinatorName(currentCoordinator) : "Manual"
    };
    taskHistory.unshift(entry);
    if (taskHistory.length > 50) taskHistory.pop();

    try {
        const result = await executeTaskLocally(taskType, payload || {});
        logEvent(`✅ Tarea manual ${taskId} completada → ${JSON.stringify(result)}`);
        entry.status = "ok";
        entry.result = result;
        entry.finishedAt = Date.now();
        activeTasks = Math.max(0, activeTasks - 1);
        updateLoad();

        if (ws && ws.readyState === WebSocket.OPEN) {
            sendTaskResult(taskId, "ok", result);
        }

        res.json({ taskId, status: "ok", result });
    } catch (err) {
        logEvent(`❌ Tarea manual ${taskId} falló: ${err.message}`, true);
        entry.status = "error";
        entry.error  = err.message;
        entry.finishedAt = Date.now();
        activeTasks = Math.max(0, activeTasks - 1);
        updateLoad();

        if (ws && ws.readyState === WebSocket.OPEN) {
            sendTaskResult(taskId, "error", { error: err.message });
        }

        res.json({ taskId, status: "error", error: err.message });
    }
});

app.get("/status", (req, res) => {
    res.json({
        id,
        port:                  PORT,
        public_url:            PUBLIC_URL,
        name:                  WORKER_NAME,
        current_coordinator:   currentCoordinator,
        known_coordinators:    knownCoordinators,
        coordinator_names:     coordinatorNames,
        pulse_interval:        PULSE_INTERVAL,
        pulse_timeout:         PULSE_TIMEOUT,
        current_timestamp:     Date.now(),
        state:                 workerState,
        logs:                  systemLogs,
        errors:                errorLogs,
        capabilities:          CAPABILITIES,
        load:                  currentLoad,
        active_tasks:          activeTasks,
        task_history:          taskHistory,
        registered_with_leader: registeredWithLeader,
        zombie_watchdog_active: zombieWatchdogTimer !== null,
        last_coordinator_msg:  lastMessageFromCoordinator
    });
});

app.listen(PORT, () => {
    console.log(`\n╔═══════════════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  Worker ${id}`);
    console.log(`║  Puerto : ${PORT}`);
    console.log(`║  URL    : ${PUBLIC_URL || "(sin ngrok)"}`);
    console.log(`║  Caps   : ${CAPABILITIES.join(", ")}`);
    console.log(`╚══════════════════════════════════════════════════════════════════════════════════════╝\n`);

    const argCoord = process.argv[4];
    if (argCoord) {
        knownCoordinators.push(argCoord);
        getCoordinatorName(argCoord);
        connectToCoordinator(argCoord);
    }
});