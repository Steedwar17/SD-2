// ─── Mapa de nombres para coordinadores ──────────────────────────────────
// Persistimos los nombres en memoria durante la sesión.
// Cada URL nueva recibe el siguiente número disponible.
const coordinatorNames = {};
let coordinatorCounter = 0;

function getCoordinatorName(url) {
    if (!coordinatorNames[url]) {
        coordinatorCounter++;
        coordinatorNames[url] = `Coordinador ${coordinatorCounter}`;
    }
    return coordinatorNames[url];
}

// ─── Conectar al coordinador ──────────────────────────────────────────────
async function connectWorker() {
    const coordinatorUrl = document.getElementById('input-coord').value.trim();
    const publicUrl      = document.getElementById('input-public').value.trim();
    const name           = document.getElementById('input-name').value.trim();

    if (!coordinatorUrl) { alert("Ingresa la URL del coordinador (wss://...)"); return; }

    // Asignamos nombre en cuanto el usuario intenta conectarse
    getCoordinatorName(coordinatorUrl);

    try {
        await fetch('/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coordinatorUrl, publicUrl, name })
        });
    } catch (e) { alert("Error al contactar el servidor local"); }
}

// ─── Cambio manual de coordinador ────────────────────────────────────────
async function changeCoordinator() {
    const newCoordinatorUrl = document.getElementById('input-coord').value.trim();
    if (!newCoordinatorUrl) { alert("Ingresa la nueva URL del coordinador"); return; }

    getCoordinatorName(newCoordinatorUrl);

    try {
        await fetch('/change-coordinator', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newCoordinatorUrl })
        });
    } catch (e) { alert("Error al cambiar coordinador"); }
}

// ─── Agregar backup ───────────────────────────────────────────────────────
async function addBackup() {
    const backupUrl = document.getElementById('input-coord').value.trim();
    if (!backupUrl) { alert("Ingresa la URL del backup en el campo de coordinador"); return; }

    getCoordinatorName(backupUrl);

    try {
        await fetch('/add-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupUrl })
        });
    } catch (e) { alert("Error al agregar backup"); }
}

// ─── Eliminar backup ──────────────────────────────────────────────────────
async function removeBackup(url) {
    if (!confirm(`¿Eliminar ${getCoordinatorName(url)} de la lista?`)) return;
    try {
        await fetch('/remove-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urlToRemove: url })
        });
    } catch (e) { alert("Error al eliminar backup"); }
}

// ─── Mover prioridad ──────────────────────────────────────────────────────
async function moveBackup(url, direction) {
    try {
        await fetch('/reorder-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urlToMove: url, direction })
        });
    } catch (e) { console.error("Error al reordenar", e); }
}

// ─── Desconectar ──────────────────────────────────────────────────────────
async function disconnectWorker() {
    try { await fetch('/disconnect', { method: 'POST' }); } catch (e) {}
}

// ─── Actualizar dashboard ─────────────────────────────────────────────────
async function updateDashboard() {
    try {
        const res  = await fetch('/status');
        const data = await res.json();

        // ── Worker info (ID completo, sin cortar) ──
        document.getElementById('w-id').textContent       = data.id || '—';
        document.getElementById('w-port').textContent     = data.port || '—';
        document.getElementById('w-interval').textContent = (data.pulse_interval || 2000) + ' ms';
        document.getElementById('w-public-url').textContent = data.public_url || 'No configurada';

        // ── Status dot en header ──
        const dot    = document.getElementById('header-dot');
        const status = data.state.status;
        dot.className = 'status-dot ' + (
            status === 'Conectado' ? 'on'  :
            status === 'Failover'  ? 'warn': 'off'
        );

        // ── Badge estado worker ──
        const wStatusEl = document.getElementById('w-status');
        const pillClass = status === 'Conectado' ? 'pill--on' :
                          status === 'Failover'  ? 'pill--warn' : 'pill--off';
        wStatusEl.innerHTML = `<span class="pill ${pillClass}">${status || 'Sin coordinador'}</span>`;

        // ── Coordinador actual (nombre + URL completa) ──
        const currentUrl = data.current_coordinator;
        if (currentUrl) {
            // Asignamos nombre si llegó por failover automático y no teníamos nombre
            getCoordinatorName(currentUrl);
            document.getElementById('c-name').textContent = getCoordinatorName(currentUrl);
            document.getElementById('c-url').textContent  = currentUrl;
        } else {
            document.getElementById('c-name').textContent = '—';
            document.getElementById('c-url').textContent  = 'No configurado';
        }

        // ── Badge conexión ──
        const cStatusEl  = document.getElementById('c-status');
        const connStatus = data.state.coordinatorStatus || '—';
        const connClass  = connStatus === 'Conectado' ? 'pill--on' : 'pill--error';
        cStatusEl.innerHTML = `<span class="pill ${connClass}">${connStatus}</span>`;

        // ── Último pulso ──
        document.getElementById('c-last').textContent = data.state.lastHeartbeat
            ? new Date(data.state.lastHeartbeat).toLocaleTimeString()
            : 'Nunca';

        // ── Lista de coordinadores conocidos ──
        // Registramos nombres para los que llegaron por sincronización automática
        (data.known_coordinators || []).forEach(url => getCoordinatorName(url));

        const list = document.getElementById('c-backups');
        if (data.known_coordinators && data.known_coordinators.length > 0) {
            list.innerHTML = data.known_coordinators.map((url, i) => {
                const isCurrent = url === data.current_coordinator;
                const isFirst   = i === 0;
                const isLast    = i === data.known_coordinators.length - 1;
                const name      = getCoordinatorName(url);
                return `
                <li class="${isCurrent ? 'active' : ''}" title="${url}">
                    <span class="priority-badge">#${i + 1}</span>
                    <span class="backup-name">${name}</span>
                    <span class="backup-url">${url}</span>
                    <div class="backup-actions">
                        <button onclick="moveBackup('${url}','up')"   ${isFirst ? 'disabled' : ''} title="Subir prioridad">↑</button>
                        <button onclick="moveBackup('${url}','down')" ${isLast  ? 'disabled' : ''} title="Bajar prioridad">↓</button>
                        <button class="del" onclick="removeBackup('${url}')" title="Eliminar">✕</button>
                    </div>
                </li>`;
            }).join('');
        } else {
            list.innerHTML = '<li style="justify-content:center; color: var(--subtle); font-size:0.82rem;">Ninguno</li>';
        }

        renderLogs(data.logs, data.errors);

    } catch (e) {
        console.error("No se puede contactar con el servidor local", e);
    }
}

// ─── Renderizar logs ──────────────────────────────────────────────────────
let lastLogHash = '';

function renderLogs(logs, errors) {
    const box  = document.getElementById('terminal-logs');
    const hash = JSON.stringify((logs || []).slice(0, 3));

    if (hash !== lastLogHash) {
        lastLogHash = hash;
        box.innerHTML = (logs || []).map(l =>
            `<div class="log-line"><span class="log-time">${l.timestamp}</span><span>${l.message}</span></div>`
        ).join('');
    }

    document.getElementById('errorCount').textContent = (errors || []).length;
    const errBox = document.getElementById('error-list');
    errBox.innerHTML = errors && errors.length > 0
        ? errors.map(e => `<div class="error-entry"><strong>${e.timestamp}</strong>${e.message}</div>`).join('')
        : '<div class="empty-state">Sin errores recientes</div>';
}

// ─── Modal ────────────────────────────────────────────────────────────────
function toggleModal() {
    document.getElementById('errorModal').classList.toggle('open');
}
function handleModalClick(e) {
    if (e.target === document.getElementById('errorModal')) toggleModal();
}

// ─── Polling ──────────────────────────────────────────────────────────────
setInterval(updateDashboard, 1000);
updateDashboard();