/**
 * js/monitor.js
 * Logic cho trang Monitor: realtime data table, 3D viewer, alarm
 * ISA-101 compliant
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout } from '/static/js/ai_chat.js';
import { DigitalTwinViewer } from '/static/js/digital_twin.js';

theme.init();

// ── State ──
let _almFilter = 'all';
let _allAlarms = [];
let _lastLoad = -1;
let _currentRange = {};
let twin = null;

// ── Helper ──
function _el(id) { return document.getElementById(id); }

// ── DOMContentLoaded ──
document.addEventListener('DOMContentLoaded', () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat({ context: 'monitor' });

    twin = new DigitalTwinViewer('digitalTwinFrame');
    twin.onReady(() => {
        console.log('✅ GLB 3D Twin ready on Monitor');
        window.cncTwin = twin;
        twin.updateLoad(0);
    });

    connectPoseStream();
    fetchLatest();
    setInterval(fetchLatest, 2000);
    fetchAlarms();
    setInterval(fetchAlarms, 10000);
    fetchMachineCtx();
    fetchSimulationComparison();
    setInterval(fetchSimulationComparison, 2000);
});


function defaultPoseWsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/pose`;
}

function sourceMessage(payload = {}) {
    const src = payload.source || payload.control_owner || 'unknown';
    if (src === 'matlab_check') return 'Đang hiển thị trajectory MATLAB CHECK — không phải chuyển động máy thật.';
    if (src === 'stream_fluidnc') return 'Đang hiển thị chuyển động máy thật từ FluidNC.';
    if (src === 'idle_fluidnc') return 'Máy Idle/Jog: đang mirror MPos từ FluidNC.';
    if (src === 'home_sync') return 'Đang đồng bộ HOME giữa FluidNC và NX MCD.';
    if (src === 'sensor_latest_fallback') return 'Fallback từ sensor latest; chờ pose stream có Sync Epoch.';
    return 'Chưa có selected pose từ Control Selector.';
}

function updateSyncGate(payload = {}) {
    const gate = _el('syncGate');
    const syncStatus = payload.sync_status || 'UNKNOWN';
    const owner = payload.control_owner || payload.source || '---';
    const check = payload.gcode_check_status || '---';
    const run = payload.run_permission || 'BLOCKED';

    _setText('dtSyncStatus', syncStatus);
    _setText('dtControlOwner', owner);
    _setText('dtCheckStatus', check);
    _setText('dtRunGate', run);
    _setText('dtPoseSource', payload.source || owner);
    _setText('dtSyncEpoch', payload.sync_epoch_id || '---');

    if (gate) {
        gate.classList.toggle('synced', syncStatus === 'MACHINE_NX_SYNCED');
        gate.classList.toggle('unsynced', syncStatus !== 'MACHINE_NX_SYNCED');
        gate.classList.toggle('ready', run === 'READY');
        gate.classList.toggle('blocked', run !== 'READY');
    }

    const ribbon = _el('dtSourceRibbon');
    if (ribbon) {
        ribbon.textContent = sourceMessage(payload);
        ribbon.className = 'twin-source-ribbon';
        if (syncStatus !== 'MACHINE_NX_SYNCED' || run !== 'READY') ribbon.classList.add('warn');
        if (payload.collision || payload.state === 'Alarm' || payload.source === 'estop') ribbon.classList.add('alarm');
    }
}

function updateTwinPose(payload = {}, opts = {}) {
    const m = payload.mpos || payload.position || {};
    if (!m || typeof m !== 'object') return;
    if (!opts.fallback) updateSyncGate(payload);
    twin?.updatePose?.(payload);
}

function connectPoseStream() {
    let retryTimer = null;
    const connect = () => {
        const ws = new WebSocket(defaultPoseWsUrl());
        ws.onopen = () => {
            const ribbon = _el('dtSourceRibbon');
            if (ribbon) ribbon.textContent = 'Pose stream connected. Waiting for Edge selected pose…';
        };
        ws.onmessage = ev => {
            try {
                const msg = JSON.parse(ev.data);
                const payload = msg.type === 'pose' ? msg.payload : msg;
                updateTwinPose(payload);
            } catch (err) {
                console.warn('Invalid pose stream packet', err);
            }
        };
        ws.onclose = () => {
            const ribbon = _el('dtSourceRibbon');
            if (ribbon) {
                ribbon.textContent = 'Pose stream disconnected. Reconnecting…';
                ribbon.className = 'twin-source-ribbon warn';
            }
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(connect, 1500);
        };
        ws.onerror = () => {
            const ribbon = _el('dtSourceRibbon');
            if (ribbon) {
                ribbon.textContent = 'Pose stream error. Check /ws/pose and Edge publisher.';
                ribbon.className = 'twin-source-ribbon warn';
            }
        };
    };
    connect();
}

// ── Fetch REALTIME latest ──
async function fetchLatest() {
    try {
        const d = await api.get('/api/monitor/sensor/latest');
        if (!d || d.status === 'no_data') return;

        const axes = d.axes || {};
        const px = +(axes.x?.position ?? d.vi_tri_x ?? 0);
        const py = +(axes.y?.position ?? d.vi_tri_y ?? 0);
        const pz = +(axes.z?.position ?? d.vi_tri_z ?? 0);
        const vx = +(axes.x?.velocity ?? d.van_toc_x ?? 0);
        const vy = +(axes.y?.velocity ?? d.van_toc_y ?? 0);
        const vz = +(axes.z?.velocity ?? d.van_toc_z ?? 0);
        const mx = +(axes.x?.torque ?? d.moment_x ?? 0);
        const my = +(axes.y?.torque ?? d.moment_y ?? 0);
        const mz = +(axes.z?.torque ?? d.moment_z ?? 0);
        const cur = +(d.current?.rms ?? d.load ?? 0);
        const feed = +(d.spindle?.load ?? 0);
        const spindle = +(d.spindle?.speed ?? 0);
        const state = d.status || 'unknown';
        const ts = d.timestamp || d.mqtt_timestamp || '';

        // ⭐ Cập nhật UI - Vị trí
        _el('posX').textContent = px.toFixed(2);
        _el('posY').textContent = py.toFixed(2);
        _el('posZ').textContent = pz.toFixed(2);

        // ⭐ Cập nhật UI - Vận tốc
        _el('velX').textContent = vx.toFixed(2);
        _el('velY').textContent = vy.toFixed(2);
        _el('velZ').textContent = vz.toFixed(2);

        // ⭐ Cập nhật UI - Moment
        _el('momX').textContent = mx.toFixed(2);
        _el('momY').textContent = my.toFixed(2);
        _el('momZ').textContent = mz.toFixed(2);

        // ⭐ Cập nhật UI - Dòng điện, Feedrate, Spindle
        _setText('current', cur.toFixed(2));
        _setText('feedrate', feed.toFixed(0));
        _setText('spindle', spindle.toFixed(0));
        _setText('monFeedRate2', feed.toFixed(0));
        _setText('monSpindle2', spindle.toFixed(0));

        // Trạng thái máy
        const dot = document.getElementById('stateDot');
        const lbl = document.getElementById('stateLabel');
        if (dot && lbl) {
            const cls = state === 'Run' ? 'run' : 
                       state === 'Alarm' ? 'alarm' : 
                       state === 'Hold' ? 'hold' : 'idle';
            dot.className = `st-dot ${cls}`;
            lbl.textContent = state;
            lbl.style.color = state === 'Alarm' ? 'var(--status-alarm)' : 
                             state === 'Run' ? 'var(--status-active)' :
                             state === 'Hold' ? 'var(--status-warning)' : 'var(--text-primary)';
        }

        // Last update time
        if (ts) try { 
            _el('lastUpdateTime').textContent = new Date(ts).toLocaleTimeString('vi-VN'); 
        } catch (_) {}

        updateTwinPose({
            source: 'sensor_latest_fallback',
            control_owner: 'sensor_latest_fallback',
            sync_status: 'UNKNOWN',
            run_permission: 'BLOCKED',
            mpos: { x: px, y: py, z: pz },
            feed, spindle, state, timestamp: ts
        }, { fallback: true });

        // ⭐ Tính % tải và gửi lên 3D Viewer
        const maxA = _currentRange.current_max_A || 10;  // fallback 10A
        const loadPct = Math.min(100, (cur / maxA) * 100);
        
        if (twin && Math.abs(cur - _lastLoad) > 0.2) {
            _lastLoad = cur;
            twin.updateLoad(loadPct);
            
            const lp = document.getElementById('loadPill');
            if (lp) {
                if (loadPct > 90) {
                    lp.textContent = `🔴 ${cur.toFixed(1)}A`;
                    lp.style.color = 'var(--status-alarm)';
                } else if (loadPct > 70) {
                    lp.textContent = `🟡 ${cur.toFixed(1)}A`;
                    lp.style.color = '#886600';
                } else if (loadPct > 0) {
                    lp.textContent = `🟢 ${cur.toFixed(1)}A`;
                    lp.style.color = 'var(--status-active)';
                } else {
                    lp.textContent = `⚪ ${cur.toFixed(1)}A`;
                    lp.style.color = 'var(--text-muted)';
                }
            }
        }

        // Range badge
        const rng = _currentRange;
        const badge = document.getElementById('rangeBadge');
        if (badge && rng.current_max_A) {
            const ratio = cur / rng.current_max_A;
            badge.textContent = `${rng.current_min_A || 0}–${rng.current_max_A}A`;
            badge.className = ratio > 1.15 ? 'st-badge alarm' : 
                             ratio > 0.9 ? 'st-badge warn' : 'st-badge';
        }

    } catch (_) {}
}

// ── Machine context ──
async function fetchMachineCtx() {
    try {
        const d = await api.get('/api/settings/machine');
        const tool = d.tool_name || d.name || '—';
        const mat = d.material_name || '—';
        _currentRange = { 
            current_min_A: d.normal_current_min_A, 
            current_max_A: d.normal_current_max_A 
        };
        _el('toolBadge').textContent = `🔧 ${tool}`;
        _el('matBadge').textContent = `🧱 ${mat}`;
    } catch (_) { 
        _currentRange = { current_min_A: 0, current_max_A: 10 };
    }
}

// ── Alarms ──
async function fetchAlarms() {
    try {
        _allAlarms = await api.get('/api/monitor/alarms', { limit: 100, resolved: false });
        const n = _allAlarms.length;
        const c = _allAlarms.filter(a => a.level === 'critical').length;
        _el('alarmCount').textContent = c > 0 ? `🔴 ${c} critical, ${n} tổng` : `${n} alarm chưa xử lý`;
        _renderAlarms(_filterAlarms(_allAlarms));
    } catch (_) {}
}

function _filterAlarms(data) {
    if (_almFilter === 'all') return data;
    return data.filter(a => a.level === _almFilter);
}

function _renderAlarms(data) {
    const body = document.getElementById('alarmBody');
    if (!body) return;
    if (!data.length) {
        body.innerHTML = `<tr><td colspan="4"><div class="empty-state">✅ Không có alarm</div></td></tr>`;
        return;
    }
    body.innerHTML = data.map(a => {
        const lv = (a.level || '').toLowerCase();
        const badge = lv === 'critical' ? `<span class="badge b-crit">🛑 Crit</span>` : 
                     lv === 'emergency' ? `<span class="badge b-emerg">🆘</span>` : 
                     `<span class="badge b-warn">⚠</span>`;
        let ts = '';
        try { ts = new Date(a.created_at).toLocaleTimeString('vi-VN'); } catch (_) { ts = ''; }
        const resolveBtn = `<button class="tbl-btn" onclick="resolveAlarm('${a._id}',this)">✓</button>`;
        return `<tr>
            <td>${badge}</td>
            <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" 
                title="${a.message || ''}">${a.message || '—'}</td>
            <td style="font-size:9px;white-space:nowrap;">${ts}</td>
            <td>${resolveBtn}</td>
        </tr>`;
    }).join('');
}

async function resolveAlarm(id, btn) {
    btn.disabled = true;
    btn.textContent = '...';
    try {
        await api.post(`/api/monitor/alarms/${id}/resolve`);
        fetchAlarms();
    } catch (e) {
        btn.disabled = false;
        btn.textContent = '✓';
    }
}

// ── TASK 4: Simulation Comparison (Actual vs Theoretical) ──────────────────
async function fetchSimulationComparison() {
    try {
        const [actual, sim] = await Promise.all([
            api.get('/api/monitor/sensor/latest'),
            api.get('/api/monitor/simulation/latest'),  // TASK 9: dùng đúng path /latest
        ]);

        if (!actual || actual.status === 'no_data') return;
        if (!sim    || sim.status    === 'no_data') return;

        const aAxes = actual.axes || {};
        const sAxes = sim.axes    || {};

        const ax = +(aAxes.x?.position ?? 0), sx = +(sAxes.x?.position ?? 0);
        const ay = +(aAxes.y?.position ?? 0), sy = +(sAxes.y?.position ?? 0);
        const az = +(aAxes.z?.position ?? 0), sz = +(sAxes.z?.position ?? 0);

        const dx = Math.abs(ax - sx);
        const dy = Math.abs(ay - sy);
        const dz = Math.abs(az - sz);

        updateDeviationDisplay(ax, ay, az, sx, sy, sz, dx, dy, dz);
    } catch (_) {}
}

function updateDeviationDisplay(ax, ay, az, sx, sy, sz, dx, dy, dz) {
    // Cập nhật actual side
    _setText('simActX', ax.toFixed(2));
    _setText('simActY', ay.toFixed(2));
    _setText('simActZ', az.toFixed(2));

    // Cập nhật theoretical side
    _setText('simThX', sx.toFixed(2));
    _setText('simThY', sy.toFixed(2));
    _setText('simThZ', sz.toFixed(2));

    // Độ lệch
    const THRESHOLD = 0.5;
    _setDeviation('simDX', dx, THRESHOLD);
    _setDeviation('simDY', dy, THRESHOLD);
    _setDeviation('simDZ', dz, THRESHOLD);

    // Tỷ lệ khớp (dựa trên max range 200mm)
    const maxRange = 200;
    const matchPct = Math.max(0, Math.min(100, (1 - (dx + dy + dz) / (3 * maxRange)) * 100));
    _setText('simMatchPct', matchPct.toFixed(0) + '%');
    const bar = _el('simMatchBar');
    if (bar) {
        bar.style.width = matchPct.toFixed(0) + '%';
        bar.style.background = matchPct > 90 ? 'var(--status-active)' : matchPct > 70 ? 'var(--status-warning)' : 'var(--status-alarm)';
    }

    // Hiện panel nếu ẩn
    const panel = _el('simComparePanel');
    if (panel) panel.style.display = 'block';
}

function _setText(id, val) {
    const el = _el(id);
    if (el) el.textContent = val;
}

function _setDeviation(id, val, threshold) {
    const el = _el(id);
    if (!el) return;
    el.textContent = 'Δ' + val.toFixed(2) + 'mm';
    el.style.color = val > threshold ? 'var(--status-alarm)' : val > threshold / 2 ? 'var(--status-warning)' : 'var(--status-active)';
}

// ── Window functions ──
window.setAlarmFilter = function (f, btn) {
    _almFilter = f;
    document.querySelectorAll('.af-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _renderAlarms(_filterAlarms(_allAlarms));
};

window.fetchAlarms = fetchAlarms;
window.resolveAlarm = resolveAlarm;
window.dtPostMsg = action => twin?._post?.({ type: 'cnc_control', action });window.toggleTwinInfoPanel = () => twin?.toggleInfoPanel?.();
