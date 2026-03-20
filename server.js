const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const PORT = process.argv[2] || 4000;

// ─── Estado principal ───────────────────────────────────────────────────────
const id = crypto.randomUUID();
let PUBLIC_URL = null;
let workerName = "Worker";
const PULSE_INTERVAL = 2000;

let knownCoordinators = []; // lista ordenada por prioridad
let currentCoordinator = null;
let ws = null;
let pulseTimer = null;
let isFailoverActive = false;

let workerState = {
    status: "Sin coordinador",       // Conectado / Failover / Sin coordinador
    coordinatorStatus: "Desconectado",
    lastHeartbeat: null
};

const systemLogs = [];
const errorLogs = [];

// ─── Logging ────────────────────────────────────────────────────────────────
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

// ─── WebSocket: conectar al coordinador ────────────────────────────────────
function connectToCoordinator(url) {
    // Cerramos conexión anterior limpiamente
    if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
        ws = null;
    }

    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }

    currentCoordinator = url;
    logEvent(`Conectando vía WebSocket a ${url}...`);

    try {
        ws = new WebSocket(url);
    } catch (err) {
        logEvent(`No se pudo crear WebSocket: ${err.message}`, true);
        scheduleFailover();
        return;
    }

    // ── Conexión abierta: registramos y arrancamos pulso ──
    ws.on("open", () => {
        logEvent(`WebSocket abierto con ${currentCoordinator}`);
        isFailoverActive = false;
        workerState.coordinatorStatus = "Conectado";
        workerState.status = "Conectado";
        register();
        pulseTimer = setInterval(sendPulse, PULSE_INTERVAL);
    });

    // ── Mensajes del coordinador ──
    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);
            logEvent(`Msg coordinador: ${JSON.stringify(data)}`);

            // Sincronizar backups si el coordinador los manda
            if (data.type === "backups" && Array.isArray(data.backups)) {
                let agregados = 0;
                data.backups.forEach(b => {
                    if (!knownCoordinators.includes(b)) {
                        knownCoordinators.push(b);
                        agregados++;
                    }
                });
                if (agregados > 0) logEvent(`Sincronizados ${agregados} backups del coordinador`);
            }

            // El coordinador no nos conoce: re-registramos
            if (data.type === "unknown") {
                logEvent("Coordinador nos olvidó, re-registrando...", true);
                register();
            }
        } catch (e) {
            logEvent(`Mensaje no parseable: ${msg}`, true);
        }
    });

    // ── Conexión cerrada: DETECTAMOS CAÍDA INMEDIATAMENTE ──
    // Esta es la ventaja clave de WebSocket sobre HTTP:
    // No hay que esperar a que falle un fetch(). En cuanto el coordinador
    // se cae, este evento se dispara solo.
    ws.on("close", () => {
        logEvent(`Conexión cerrada con ${currentCoordinator}`, true);
        workerState.coordinatorStatus = "Desconectado";
        if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
        scheduleFailover();
    });

    ws.on("error", (err) => {
        // "close" se disparará justo después, el failover lo maneja ese handler
        logEvent(`Error WS: ${err.message}`, true);
    });
}

// ─── Registro ───────────────────────────────────────────────────────────────
function register() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: "register",
        id,
        url: PUBLIC_URL,
        name: workerName
    }));
    logEvent(`Registrado en ${currentCoordinator}`);
}

// ─── Pulso periódico ────────────────────────────────────────────────────────
function sendPulse() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "pulse", id }));
    workerState.lastHeartbeat = Date.now();
    logEvent("💓 Pulso enviado");
}

// ─── Failover: saltar al siguiente coordinador conocido ─────────────────────
function scheduleFailover() {
    if (isFailoverActive) return;
    isFailoverActive = true;
    workerState.status = "Failover";

    if (knownCoordinators.length <= 1) {
        logEvent("Sin backups disponibles, reintentando en 5s...", true);
        workerState.status = "Sin coordinador";
        setTimeout(() => {
            isFailoverActive = false;
            if (currentCoordinator) connectToCoordinator(currentCoordinator);
        }, 5000);
        return;
    }

    const currentIndex = knownCoordinators.indexOf(currentCoordinator);
    const nextIndex = (currentIndex + 1) % knownCoordinators.length;
    const nextCoordinator = knownCoordinators[nextIndex];

    logEvent(`Failover activado → cambiando a ${nextCoordinator}`, true);

    setTimeout(() => {
        isFailoverActive = false;
        connectToCoordinator(nextCoordinator);
    }, 2000);
}

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Endpoints HTTP (para la interfaz web local) ────────────────────────────

// Conectar o cambiar coordinador principal
app.post("/connect", (req, res) => {
    const { coordinatorUrl, publicUrl, name } = req.body;
    if (!coordinatorUrl) return res.status(400).json({ error: "Falta coordinatorUrl" });

    if (publicUrl) PUBLIC_URL = publicUrl;
    if (name) workerName = name;

    if (!knownCoordinators.includes(coordinatorUrl)) {
        knownCoordinators.unshift(coordinatorUrl); // prioridad más alta
    } else {
        // lo movemos al frente para que sea el primario
        knownCoordinators = [coordinatorUrl, ...knownCoordinators.filter(u => u !== coordinatorUrl)];
    }

    logEvent(`Conexión iniciada hacia ${coordinatorUrl}`);
    connectToCoordinator(coordinatorUrl);
    res.json({ message: "Conectando..." });
});

// Endpoint del taller: cambio manual de coordinador
app.post("/change-coordinator", (req, res) => {
    const { newCoordinatorUrl } = req.body;
    if (!newCoordinatorUrl) return res.status(400).json({ error: "Falta newCoordinatorUrl" });

    if (!knownCoordinators.includes(newCoordinatorUrl)) {
        knownCoordinators.push(newCoordinatorUrl);
        logEvent(`Nuevo coordinador agregado a la lista: ${newCoordinatorUrl}`);
    }

    logEvent(`Cambio manual de coordinador → ${newCoordinatorUrl}`);
    connectToCoordinator(newCoordinatorUrl);
    res.json({ message: "Cambiando coordinador..." });
});

// Agregar backup manualmente
app.post("/add-backup", (req, res) => {
    const { backupUrl } = req.body;
    if (!backupUrl) return res.status(400).json({ error: "Falta backupUrl" });

    if (!knownCoordinators.includes(backupUrl)) {
        knownCoordinators.push(backupUrl);
        logEvent(`Backup agregado: ${backupUrl}`);
    }
    res.json({ message: "Backup guardado" });
});

// Eliminar un coordinador de la lista
app.post("/remove-backup", (req, res) => {
    const { urlToRemove } = req.body;
    knownCoordinators = knownCoordinators.filter(u => u !== urlToRemove);
    logEvent(`Backup eliminado: ${urlToRemove}`);

    if (urlToRemove === currentCoordinator) {
        if (knownCoordinators.length > 0) {
            scheduleFailover();
        } else {
            if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
            currentCoordinator = null;
            workerState.status = "Sin coordinador";
            workerState.coordinatorStatus = "Desconectado";
        }
    }
    res.json({ message: "Eliminado" });
});

// Cambiar prioridad en la lista
app.post("/reorder-backup", (req, res) => {
    const { urlToMove, direction } = req.body;
    const index = knownCoordinators.indexOf(urlToMove);
    if (index === -1) return res.status(404).json({ error: "No encontrado" });

    if (direction === "up" && index > 0) {
        [knownCoordinators[index - 1], knownCoordinators[index]] =
            [knownCoordinators[index], knownCoordinators[index - 1]];
        logEvent(`Subida prioridad: ${urlToMove}`);
    } else if (direction === "down" && index < knownCoordinators.length - 1) {
        [knownCoordinators[index + 1], knownCoordinators[index]] =
            [knownCoordinators[index], knownCoordinators[index + 1]];
        logEvent(`Bajada prioridad: ${urlToMove}`);
    }
    res.json({ message: "Prioridad actualizada" });
});

// Desconectar
app.post("/disconnect", (req, res) => {
    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
    if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
    currentCoordinator = null;
    workerState.status = "Sin coordinador";
    workerState.coordinatorStatus = "Desconectado";
    logEvent("Worker desconectado manualmente");
    res.json({ message: "Detenido" });
});

// Estado completo para el dashboard
app.get("/status", (req, res) => {
    res.json({
        id,
        port: PORT,
        public_url: PUBLIC_URL,
        name: workerName,
        current_coordinator: currentCoordinator,
        known_coordinators: knownCoordinators,
        pulse_interval: PULSE_INTERVAL,
        current_timestamp: Date.now(),
        state: workerState,
        logs: systemLogs,
        errors: errorLogs
    });
});

// ─── Arranque ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Worker ${id} corriendo en http://localhost:${PORT}`);
    // Si se pasan argumentos al arrancar, conectamos directo
    // Uso: node server.js <PORT> <WS_COORDINATOR_URL> <PUBLIC_URL> <NOMBRE>
    const argCoord = process.argv[3];
    const argPublic = process.argv[4];
    const argName = process.argv[5];
    if (argCoord && argPublic) {
        PUBLIC_URL = argPublic;
        if (argName) workerName = argName;
        knownCoordinators.push(argCoord);
        connectToCoordinator(argCoord);
    }
});