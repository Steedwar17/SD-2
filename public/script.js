const coordinatorNames = {};
let   coordinatorCounter = 0;

const MAX_VISIBLE_TASKS = 4;


let totalTasksSeen = 0;
const seenTaskIds = new Set();

function getCoordinatorName(url) {
    if (!url) return "Desconocido";
    if (!coordinatorNames[url]) {
        coordinatorCounter++;
        coordinatorNames[url] = `Coordinador ${coordinatorCounter}`;
    }
    return coordinatorNames[url];
}

async function connectWorker() {
    const coordinatorUrl = document.getElementById('input-coord').value.trim();
    if (!coordinatorUrl) { alert("Ingresa la URL del coordinador (wss://...)"); return; }
    try {
        await fetch('/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coordinatorUrl })
        });
    } catch (e) { alert("Error al contactar el servidor local"); }
}

async function changeCoordinator() {
    const newCoordinatorUrl = document.getElementById('input-coord').value.trim();
    if (!newCoordinatorUrl) { alert("Ingresa la nueva URL del coordinador"); return; }
    try {
        await fetch('/change-coordinator', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newCoordinatorUrl })
        });
    } catch (e) { alert("Error al cambiar coordinador"); }
}

async function addBackup() {
    const backupUrl = (document.getElementById('input-backup') || document.getElementById('input-coord')).value.trim();
    if (!backupUrl) { alert("Ingresa la URL del backup"); return; }
    try {
        await fetch('/add-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupUrl })
        });
    } catch (e) { alert("Error al agregar backup"); }
}

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

async function moveBackup(url, direction) {
    try {
        await fetch('/reorder-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urlToMove: url, direction })
        });
    } catch (e) { console.error("Error al reordenar", e); }
}

async function disconnectWorker() {
    try { await fetch('/disconnect', { method: 'POST' }); } catch (e) {}
}

function taskIcon(type) {
    return type === 'math_compute'  ? '🧮'
         : type === 'http_fetch'    ? '🌐'
         : type === 'power_compute' ? '⚡'
         : '⚙️';
}

function formatPayload(type, payload) {
    if (!payload) return '—';
    switch (type) {
        case 'math_compute': {
            const sym = { add: '+', sub: '−', mul: '×', div: '÷' }[payload.operation] || payload.operation;
            return `${payload.a}  ${sym}  ${payload.b}`;
        }
        case 'http_fetch':
            return payload.url || '—';
        case 'power_compute':
            return `${payload.base} ^ ${payload.exponent}`;
        default:
            return JSON.stringify(payload);
    }
}

function formatResult(type, result, error) {
    if (error) return { html: `<span class="res-error">❌ ${escHtml(error)}</span>` };
    if (!result) return { html: '<span class="res-muted">—</span>' };
    switch (type) {
        case 'math_compute':
        case 'power_compute':
            return { html: `<span class="res-ok">= ${result.result}</span>` };
        case 'http_fetch': {
            const bodyStr = typeof result.body === 'object'
                ? JSON.stringify(result.body).slice(0, 150)
                : String(result.body || '').slice(0, 150);
            return { html: `<span class="res-ok">HTTP ${result.status}</span> <span class="res-body">${escHtml(bodyStr)}</span>` };
        }
        default:
            return { html: `<span class="res-ok">${escHtml(JSON.stringify(result).slice(0, 150))}</span>` };
    }
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

let renderedTaskIds = new Set();

function renderTaskFeed(tasks, namesFromServer) {
    if (namesFromServer) Object.assign(coordinatorNames, namesFromServer);

    const running = tasks.filter(t => t.status === 'running').length;
    const ok      = tasks.filter(t => t.status === 'ok').length;
    const errors  = tasks.filter(t => t.status === 'error').length;
    document.getElementById('cnt-running-num').textContent = running;
    document.getElementById('cnt-ok-num').textContent      = ok;
    document.getElementById('cnt-error-num').textContent   = errors;

    tasks.forEach(t => {
        if (!seenTaskIds.has(t.taskId)) {
            seenTaskIds.add(t.taskId);
            totalTasksSeen++;
        }
    });
    document.getElementById('cnt-total-num').textContent = totalTasksSeen;

    const feed = document.getElementById('task-feed');
    const overflowNote = document.getElementById('feed-overflow-note');

    if (!tasks || tasks.length === 0) {
        if (!feed.querySelector('.feed-empty')) {
            feed.innerHTML = `
                <div class="feed-empty">
                    <div class="feed-empty-icon">⏳</div>
                    <p>Esperando tareas del coordinador...</p>
                    <p class="feed-empty-sub">Las tareas llegan y se ejecutan automáticamente</p>
                </div>`;
        }
        renderedTaskIds.clear();
        overflowNote.style.display = 'none';
        return;
    }

    const empty = feed.querySelector('.feed-empty');
    if (empty) empty.remove();

    const visibleTasks = tasks.slice(0, MAX_VISIBLE_TASKS);
    const hiddenCount  = tasks.length - visibleTasks.length;

    if (hiddenCount > 0) {
        overflowNote.style.display = 'block';
        overflowNote.textContent   = `+${hiddenCount} tarea${hiddenCount !== 1 ? 's' : ''} más en el historial del servidor (solo se muestran las ${MAX_VISIBLE_TASKS} más recientes)`;
    } else {
        overflowNote.style.display = 'none';
    }

    const visibleIds = new Set(visibleTasks.map(t => t.taskId));

    [...feed.children].forEach(child => {
        const id = child.id?.replace('tc-', '');
        if (id && !visibleIds.has(id)) {
            child.remove();
            renderedTaskIds.delete(id);
        }
    });

    visibleTasks.forEach(t => {
        const existing  = document.getElementById(`tc-${t.taskId}`);
        const isRunning = t.status === 'running';

        const coordName  = t.coordinatorName || getCoordinatorName(t.coordinatorUrl);
        const payloadStr = formatPayload(t.type, t.payload);
        const resHtml    = formatResult(t.type, t.result, t.error);
        const duration   = (t.finishedAt && t.startedAt) ? `${t.finishedAt - t.startedAt}ms` : isRunning ? '...' : '—';
        const timeStr    = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : '';
        const statusCls  = isRunning ? 'pill--warn' : t.status === 'ok' ? 'pill--on' : 'pill--error';
        const statusTxt  = isRunning ? 'ejecutando' : t.status;

        const innerHtml = `
            <div class="tc-top">
                <div class="tc-left">
                    <span class="tc-icon">${taskIcon(t.type)}</span>
                    <div class="tc-info">
                        <span class="tc-type">${t.type}</span>
                        <span class="tc-payload">${escHtml(payloadStr)}</span>
                    </div>
                </div>
                <div class="tc-right">
                    <span class="pill ${statusCls}">${statusTxt}</span>
                    <span class="tc-duration mono">${duration}</span>
                </div>
            </div>

            <div class="tc-from">
                <div class="from-row">
                    <span class="from-badge">DE</span>
                    <span class="from-name">${escHtml(coordName)}</span>
                    <span class="from-url mono">${escHtml(t.coordinatorUrl || '')}</span>
                </div>
                <span class="tc-time mono">${timeStr}</span>
            </div>

            <div class="tc-response">
                <span class="response-label">Respuesta enviada:</span>
                <div class="response-value mono">
                    ${isRunning
                        ? '<span class="running-dots"><span>.</span><span>.</span><span>.</span></span> procesando...'
                        : resHtml.html
                    }
                </div>
            </div>

            <div class="tc-footer mono">ID: ${t.taskId}</div>`;

        if (existing) {
            if (existing.dataset.status !== t.status) {
                existing.dataset.status = t.status;
                existing.className = `task-card ${isRunning ? 'task-card--running' : ''}`;
                existing.innerHTML = innerHtml;
            }
        } else {
            const card = document.createElement('div');
            card.id             = `tc-${t.taskId}`;
            card.className      = `task-card ${isRunning ? 'task-card--running' : ''}`;
            card.dataset.status = t.status;
            card.innerHTML      = innerHtml;
            feed.insertBefore(card, feed.firstChild);
            renderedTaskIds.add(t.taskId);
        }
    });
}

async function updateDashboard() {
    try {
        const res  = await fetch('/status');
        const data = await res.json();

        document.getElementById('w-id').textContent         = data.id || '—';
        document.getElementById('w-port').textContent       = data.port || '—';
        document.getElementById('w-interval').textContent   = (data.pulse_interval || 3000) + ' ms';
        document.getElementById('w-public-url').textContent = data.public_url || 'No configurada';

      
        const dot    = document.getElementById('header-dot');
        const status = data.state.status;
        dot.className = 'status-dot ' + (
            status === 'Conectado' ? 'on' :
            status === 'Failover'  ? 'warn' : 'off'
        );

       
        const pillClass = status === 'Conectado' ? 'pill--on' : status === 'Failover' ? 'pill--warn' : 'pill--off';
        document.getElementById('w-status').innerHTML = `<span class="pill ${pillClass}">${status || 'Sin coordinador'}</span>`;

       
        const loadPct = Math.round((data.load || 0) * 100);
        const bar     = document.getElementById('w-load-bar');
        bar.style.width = loadPct + '%';
        bar.className   = 'load-bar ' + (loadPct >= 80 ? 'load-bar--high' : loadPct >= 40 ? 'load-bar--mid' : 'load-bar--low');
        document.getElementById('w-load-label').textContent = loadPct + '%';

        
        const capEl = document.getElementById('w-capabilities');
        capEl.innerHTML = (data.capabilities || []).map(c => `<span class="cap-tag">${c}</span>`).join('') ||
            '<span class="muted-text">Ninguna</span>';

        const leaderRegEl = document.getElementById('w-leader-reg');
        if (leaderRegEl) {
            const regOk = data.registered_with_leader || data.state?.registeredWithLeader;
            leaderRegEl.innerHTML = regOk
                ? '<span class="pill pill--on">✓ Registrado con líder</span>'
                : '<span class="pill pill--off">Sin confirmar</span>';
        }
        const watchdogEl = document.getElementById('w-watchdog');
        if (watchdogEl) {
            const active = data.zombie_watchdog_active;
            watchdogEl.innerHTML = active
                ? '<span class="pill pill--on">Activo</span>'
                : '<span class="pill pill--off">Inactivo</span>';
        }

        const cu = data.current_coordinator;
        if (cu) {
            getCoordinatorName(cu);
            document.getElementById('c-name').textContent = getCoordinatorName(cu);
            document.getElementById('c-url').textContent  = cu;
        } else {
            document.getElementById('c-name').textContent = '—';
            document.getElementById('c-url').textContent  = 'No configurado';
        }

        const connStatus = data.state.coordinatorStatus || '—';
        const connClass  = connStatus === 'Conectado' ? 'pill--on' : 'pill--error';
        document.getElementById('c-status').innerHTML = `<span class="pill ${connClass}">${connStatus}</span>`;
        document.getElementById('c-last').textContent = data.state.lastHeartbeat
            ? new Date(data.state.lastHeartbeat).toLocaleTimeString() : 'Nunca';

        (data.known_coordinators || []).forEach(u => getCoordinatorName(u));
        const list = document.getElementById('c-backups');
        if (data.known_coordinators && data.known_coordinators.length > 0) {
            list.innerHTML = data.known_coordinators.map((url, i) => {
                const isCurrent = url === data.current_coordinator;
                const isFirst   = i === 0;
                const isLast    = i === data.known_coordinators.length - 1;
                return `
                <li class="${isCurrent ? 'active' : ''}" title="${url}">
                    <span class="priority-badge">#${i + 1}</span>
                    <span class="backup-name">${getCoordinatorName(url)}</span>
                    <span class="backup-url">${url}</span>
                    <div class="backup-actions">
                        <button onclick="moveBackup('${url}','up')"   ${isFirst ? 'disabled' : ''}>↑</button>
                        <button onclick="moveBackup('${url}','down')" ${isLast  ? 'disabled' : ''}>↓</button>
                        <button class="del" onclick="removeBackup('${url}')">✕</button>
                    </div>
                </li>`;
            }).join('');
        } else {
            list.innerHTML = '<li class="empty-li">Ninguno</li>';
        }
        renderTaskFeed(data.task_history || [], data.coordinator_names);

        renderLogs(data.logs, data.errors);

    } catch (e) {
        console.error("No se puede contactar con el servidor local", e);
    }
}

let lastLogHash = '';

function renderLogs(logs, errors) {
    const box  = document.getElementById('terminal-logs');
    const hash = JSON.stringify((logs || []).slice(0, 3));
    if (hash !== lastLogHash) {
        lastLogHash = hash;
        box.innerHTML = (logs || []).map(l =>
            `<div class="log-line"><span class="log-time">${l.timestamp}</span><span>${escHtml(l.message)}</span></div>`
        ).join('');
        box.scrollTop = 0;
    }

    document.getElementById('errorCount').textContent = (errors || []).length;
    document.getElementById('error-list').innerHTML = errors && errors.length > 0
        ? errors.map(e => `<div class="error-entry"><strong>${e.timestamp}</strong>${escHtml(e.message)}</div>`).join('')
        : '<div class="empty-state">Sin errores recientes</div>';
}

function toggleModal() {
    document.getElementById('errorModal').classList.toggle('open');
}
function handleModalClick(e) {
    if (e.target === document.getElementById('errorModal')) toggleModal();
}

let currentTaskType = 'math_compute';

function selectTaskType(type) {
    currentTaskType = type;
    document.querySelectorAll('.task-tab').forEach(btn => {
        btn.classList.toggle('task-tab--active', btn.dataset.type === type);
    });
    document.querySelectorAll('.task-form').forEach(form => {
        form.classList.toggle('task-form--hidden', form.id !== `form-${type}`);
    });

    clearManualResult();
}

function buildPayload() {
    switch (currentTaskType) {
        case 'math_compute': {
            const operation = document.getElementById('math-op').value;
            const a = parseFloat(document.getElementById('math-a').value);
            const b = parseFloat(document.getElementById('math-b').value);
            if (isNaN(a) || isNaN(b)) throw new Error("Los campos a y b deben ser números");
            return { operation, a, b };
        }
        case 'http_fetch': {
            const url = document.getElementById('fetch-url').value.trim();
            if (!url) throw new Error("Ingresa una URL válida");
            return { url };
        }
        case 'power_compute': {
            const base     = parseFloat(document.getElementById('power-base').value);
            const exponent = parseFloat(document.getElementById('power-exp').value);
            if (isNaN(base) || isNaN(exponent)) throw new Error("Base y exponente deben ser números");
            return { base, exponent };
        }
        default:
            throw new Error("Tipo de tarea no reconocido");
    }
}

async function sendManualTask() {
    const wrap   = document.getElementById('manual-result-wrap');
    const result = document.getElementById('manual-result');

    let payload;
    try {
        payload = buildPayload();
    } catch (e) {
        wrap.style.display = 'block';
        result.innerHTML   = `<span class="res-error">❌ ${escHtml(e.message)}</span>`;
        return;
    }
    wrap.style.display = 'block';
    result.innerHTML   = '<span class="running-dots"><span>.</span><span>.</span><span>.</span></span> enviando...';

    try {
        const res  = await fetch('/send-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: currentTaskType, payload })
        });
        const data = await res.json();

        if (data.status === 'ok') {
            const resultStr = JSON.stringify(data.result, null, 2);
            result.innerHTML = `<span class="res-ok">✅ ok</span>\n<span class="res-body">${escHtml(resultStr)}</span>`;
        } else {
            result.innerHTML = `<span class="res-error">❌ error: ${escHtml(data.error || 'Error desconocido')}</span>`;
        }
    } catch (e) {
        result.innerHTML = `<span class="res-error">❌ ${escHtml(e.message)}</span>`;
    }
}

function clearManualResult() {
    const wrap = document.getElementById('manual-result-wrap');
    if (wrap) wrap.style.display = 'none';
}
setInterval(updateDashboard, 800);
updateDashboard();