/**
 * js/monitor.js
 * Logic cho trang Monitor (Giam Sat): realtime status bar, 4 chart
 * (Position/Velocity/Moment/Current), bang Alarm, badge Tool/Material,
 * dieu khien khoang thoi gian + nguon du lieu (physical/virtual/both).
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { createLineChart, pushChart, pushRolling, clearCharts, AXIS_COLORS } from '/static/js/charts.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout } from '/static/js/ai_chat.js';
import { DigitalTwinViewer } from '/static/js/digital_twin.js';

// Khởi tạo viewer với iframe #cncFrame
const twin = new DigitalTwinViewer('cncFrame');

// Đăng ký callback khi viewer sẵn sàng
twin.onReady(() => {
    console.log('3D Viewer ready');
    // Gửi load hiện tại ngay khi ready
    fetchAndSendLoad();
});

// Hàm gửi load lên viewer
function sendLoadToViewer(loadPercent) {
    twin.updateLoad(loadPercent);
}

// Trong fetchRealtimeStatus, gọi sendLoadToViewer
async function fetchRealtimeStatus() {
    try {
        // ... lấy data
        const loadPercent = Math.min((current / 5) * 100, 100);
        sendLoadToViewer(loadPercent);
        updateLoadStatus(loadPercent);
    } catch (e) {
        console.error('Fetch realtime error:', e);
    }
}

// Khi trang unload, dọn dẹp
window.addEventListener('beforeunload', () => {
    twin.destroy();
});

// ── State ─────────────────────────────────────────────────────────────────
let _minutes = 60, _source = 'physical', _almFilter = 'all', _allAlarms = [], _lastLoad = -1;
let _currentRange = {};

// ── Charts ────────────────────────────────────────────────────────────────
let cPos, cVel, cMom, cCur;

function initCharts() {
    cPos = createLineChart('chartPos', [{ label: 'X', color: AXIS_COLORS.x }, { label: 'Y', color: AXIS_COLORS.y }, { label: 'Z', color: AXIS_COLORS.z }]);
    cVel = createLineChart('chartVel', [{ label: 'Vx', color: AXIS_COLORS.x }, { label: 'Vy', color: AXIS_COLORS.y }, { label: 'Vz', color: AXIS_COLORS.z }]);
    cMom = createLineChart('chartMom', [{ label: 'Mx', color: AXIS_COLORS.x }, { label: 'My', color: AXIS_COLORS.y }, { label: 'Mz', color: AXIS_COLORS.z }]);
    cCur = createLineChart('chartCurrent', [{ label: 'I(A)', color: AXIS_COLORS.i }]);
}

// ── Fetch REALTIME latest (moi 2s) ───────────────────────────────────────
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

        _el('posX').textContent = px.toFixed(2);
        _el('posY').textContent = py.toFixed(2);
        _el('posZ').textContent = pz.toFixed(2);
        _el('curVal').textContent = cur.toFixed(2);
        _el('feedVal').textContent = feed.toFixed(0);
        _el('spindleVal').textContent = spindle.toFixed(0);

        const dot = document.getElementById('stateDot');
        const lbl = document.getElementById('stateLabel');
        if (dot && lbl) {
            const cls = state === 'Run' ? 'run' : state === 'Alarm' ? 'alarm' : state === 'Hold' ? 'hold' : 'idle';
            dot.className = `st-dot ${cls}`;
            lbl.textContent = state;
            lbl.style.color = state === 'Alarm' ? 'var(--status-alarm)' : state === 'Run' ? 'var(--status-active)' : state === 'Hold' ? 'var(--status-warning)' : 'var(--text-primary)';
        }

        _el('cvX').textContent = px.toFixed(2); _el('cvY').textContent = py.toFixed(2); _el('cvZ').textContent = pz.toFixed(2);
        _el('cvVx').textContent = vx.toFixed(2); _el('cvVy').textContent = vy.toFixed(2); _el('cvVz').textContent = vz.toFixed(2);
        _el('cvMx').textContent = mx.toFixed(2); _el('cvMy').textContent = my.toFixed(2); _el('cvMz').textContent = mz.toFixed(2);
        _el('cvI').textContent = cur.toFixed(2);

        if (cCur) {
            const t = ts ? new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
            pushRolling(cCur, t, [cur], 60);
        }

        const rng = _currentRange;
        if (rng.current_max_A) {
            const ratio = cur / rng.current_max_A;
            const st = ratio > 1.15 ? '🔴 QUÁ NGƯỠNG' : ratio > 0.9 ? '🟡 Gần ngưỡng' : '🟢 Bình thường';
            _el('currentStatus').textContent = st;
            const badge = document.getElementById('rangeBadge');
            if (badge) { badge.textContent = `${rng.current_min_A}–${rng.current_max_A}A`; badge.className = ratio > 1.15 ? 'st-badge alarm' : ratio > 0.9 ? 'st-badge warn' : 'st-badge'; }
        }

        if (ts) try { _el('lastUpdateTime').textContent = new Date(ts).toLocaleTimeString('vi-VN'); } catch (_) {}

        if (Math.abs(cur - _lastLoad) > 0.3) {
            _lastLoad = cur;
            const maxA = _currentRange.current_max_A || 5;
            const loadPct = Math.min(100, (cur / maxA) * 100);
            twin.updateLoad(loadPct);
            const lp = document.getElementById('loadPill');
            if (lp) lp.textContent = loadPct > 90 ? `🔴 ${cur.toFixed(1)}A` : loadPct > 70 ? `🟡 ${cur.toFixed(1)}A` : `🟢 ${cur.toFixed(1)}A`;
        }
    } catch (_) {}
}

// ── Fetch HISTORY chart (moi 30s) ────────────────────────────────────────
async function fetchChart() {
    try {
        const physArr = (_source === 'both' || _source === 'physical') ? await api.get('/api/monitor/sensor/history', { minutes: _minutes, limit: 300 }) : [];
        const simArr = (_source === 'both' || _source === 'virtual') ? await api.get('/api/monitor/simulation/history', { minutes: _minutes, limit: 200 }) : [];
        const arr = _source === 'virtual' ? simArr : physArr;

        clearCharts([cPos, cVel, cMom]);
        arr.forEach(d => {
            const ts = d.timestamp || d.mqtt_timestamp || d.created_at || '';
            let t = ''; try { t = new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); } catch (_) { t = ts.slice(11, 16); }
            const axes = d.axes || {};
            const px = +(axes.x?.position ?? d.vi_tri_x ?? 0), py = +(axes.y?.position ?? d.vi_tri_y ?? 0), pz = +(axes.z?.position ?? d.vi_tri_z ?? 0);
            const vx = +(axes.x?.velocity ?? d.van_toc_x ?? 0), vy = +(axes.y?.velocity ?? d.van_toc_y ?? 0), vz = +(axes.z?.velocity ?? d.van_toc_z ?? 0);
            const mx = +(axes.x?.torque ?? d.moment_x ?? 0), my = +(axes.y?.torque ?? d.moment_y ?? 0), mz = +(axes.z?.torque ?? d.moment_z ?? 0);
            pushChart(cPos, t, [px, py, pz]);
            pushChart(cVel, t, [vx, vy, vz]);
            pushChart(cMom, t, [mx, my, mz]);
        });
        [cPos, cVel, cMom].forEach(c => c?.update());
        _el('chartInfo').textContent = `🕒 ${new Date().toLocaleTimeString('vi-VN')} | ${arr.length} điểm | ${_source === 'virtual' ? '🔬 MATLAB' : '📡 ESP32'}`;
    } catch (e) { _el('chartInfo').textContent = '❌ ' + e.message; }
}

// ── Machine context (Neo4j via /api/settings/machine) ────────────────────
async function fetchMachineCtx() {
    try {
        const d = await api.get('/api/settings/machine');
        const tool = d.tool_name || d.name || '—', mat = d.material_name || '—';
        _currentRange = { current_min_A: d.normal_current_min_A, current_max_A: d.normal_current_max_A };
        _el('toolBadge').textContent = `🔧 ${tool}`;
        _el('matBadge').textContent = `🧱 ${mat}`;
    } catch (_) { _currentRange = {}; }
}

// ── Alarms ────────────────────────────────────────────────────────────────
async function fetchAlarms() {
    try {
        _allAlarms = await api.get('/api/monitor/alarms', { limit: 100, resolved: false });
        const n = _allAlarms.length, c = _allAlarms.filter(a => a.level === 'critical').length;
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
    if (!data.length) { body.innerHTML = `<tr><td colspan="4"><div class="empty-state">✅ Không có alarm</div></td></tr>`; return; }
    body.innerHTML = data.map(a => {
        const lv = (a.level || '').toLowerCase();
        const badge = lv === 'critical' ? `<span class="badge b-crit">🛑 Crit</span>` : lv === 'emergency' ? `<span class="badge b-emerg">🆘</span>` : `<span class="badge b-warn">⚠</span>`;
        let ts = ''; try { ts = new Date(a.created_at).toLocaleTimeString('vi-VN'); } catch (_) { ts = ''; }
        const resolveBtn = `<button class="tbl-btn" onclick="resolveAlarm('${a._id}',this)">✓</button>`;
        return `<tr>
            <td>${badge}</td>
            <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${a.message || ''}">${a.message || '—'}</td>
            <td style="font-size:9px;white-space:nowrap;">${ts}</td>
            <td>${resolveBtn}</td>
        </tr>`;
    }).join('');
}

async function resolveAlarm(id, btn) {
    btn.disabled = true; btn.textContent = '...';
    try { await api.post(`/api/monitor/alarms/${id}/resolve`); fetchAlarms(); }
    catch (e) { btn.disabled = false; btn.textContent = '✓'; }
}

window.setTime = function (min, btn) {
    _minutes = min;
    document.querySelectorAll('.ctrl-row:first-of-type .ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); fetchChart();
};
window.setSource = function (src, btn) {
    _source = src;
    document.querySelectorAll('.ctrl-row:nth-of-type(2) .ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); fetchChart();
};
window.setAlarmFilter = function (f, btn) {
    _almFilter = f;
    document.querySelectorAll('.af-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); _renderAlarms(_filterAlarms(_allAlarms));
};
window.fetchAlarms = fetchAlarms;
window.resolveAlarm = resolveAlarm;

// ── Helper ────────────────────────────────────────────────────────────────
function _el(id) { return document.getElementById(id); }
