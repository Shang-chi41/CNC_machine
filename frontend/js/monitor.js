/**
 * js/monitor.js
 * Logic cho trang Monitor: realtime status, 3D viewer, alarm
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout } from '/static/js/ai_chat.js';
import { DigitalTwinViewer } from '/static/js/digital_twin.js';

theme.init();

// ── BIẾN TOÀN CỤC ──
let _almFilter = 'all';
let _allAlarms = [];
let _lastLoad = -1;
let _currentRange = {};
let _twin = null;

// ── HELPER ──
function _el(id) { return document.getElementById(id); }

function getTwin() {
    return _twin;
}

// ── DOMContentLoaded ──
document.addEventListener('DOMContentLoaded', async () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat();

    // Khởi tạo 3D Viewer
    _twin = new DigitalTwinViewer('cncFrame');
    _twin.onReady(() => {
        console.log('✅ 3D Viewer ready on Monitor');
    });

    // ⭐ Lấy ngưỡng dòng điện của máy TRƯỚC khi bắt đầu đọc dữ liệu realtime.
    // Nếu không, lần đọc đầu tiên sẽ dùng ngưỡng fallback quá thấp và tính
    // nhầm % tải > 100%, khiến model 3D bị tô đỏ "quá tải" ngay khi chưa có tải thật.
    await fetchMachineCtx();

    fetchLatest();
    setInterval(fetchLatest, 2000);
    fetchAlarms();
    setInterval(fetchAlarms, 10000);
});

// ── Fetch REALTIME latest (mỗi 2s) ──
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

        // ⭐ Tính Speed và Torque
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const torque = Math.sqrt(mx * mx + my * my + mz * mz);

        // ⭐ Cập nhật UI
        _el('posX').textContent = px.toFixed(2);
        _el('posY').textContent = py.toFixed(2);
        _el('posZ').textContent = pz.toFixed(2);
        _el('speedVal').textContent = speed.toFixed(1);
        _el('torqueVal').textContent = torque.toFixed(2);
        _el('curVal').textContent = cur.toFixed(2);
        _el('feedVal').textContent = feed.toFixed(0);
        _el('spindleVal').textContent = spindle.toFixed(0);

        // ⭐ Bảng chi tiết theo từng trục (vị trí / vận tốc / moment)
        _el('axPosX').textContent = px.toFixed(2);
        _el('axPosY').textContent = py.toFixed(2);
        _el('axPosZ').textContent = pz.toFixed(2);
        _el('axVelX').textContent = vx.toFixed(2);
        _el('axVelY').textContent = vy.toFixed(2);
        _el('axVelZ').textContent = vz.toFixed(2);
        _el('axTorX').textContent = mx.toFixed(2);
        _el('axTorY').textContent = my.toFixed(2);
        _el('axTorZ').textContent = mz.toFixed(2);

        // Trạng thái máy
        const dot = document.getElementById('stateDot');
        const lbl = document.getElementById('stateLabel');
        if (dot && lbl) {
            const cls = state === 'Run' ? 'run' : state === 'Alarm' ? 'alarm' : state === 'Hold' ? 'hold' : 'idle';
            dot.className = `st-dot ${cls}`;
            lbl.textContent = state;
            lbl.style.color = state === 'Alarm' ? 'var(--status-alarm)' : 
                             state === 'Run' ? 'var(--status-active)' :
                             state === 'Hold' ? 'var(--status-warning)' : 'var(--text-primary)';
        }

        // Range badge
        const rng = _currentRange;
        if (rng.current_max_A) {
            const ratio = cur / rng.current_max_A;
            const badge = document.getElementById('rangeBadge');
            if (badge) {
                badge.textContent = `${rng.current_min_A}–${rng.current_max_A}A`;
                badge.className = ratio > 1.15 ? 'st-badge alarm' : 
                                 ratio > 0.9 ? 'st-badge warn' : 'st-badge';
            }
        }

        // Last update time
        if (ts) try { 
            _el('lastUpdateTime').textContent = new Date(ts).toLocaleTimeString('vi-VN'); 
        } catch (_) {}

        // ⭐ Gửi load lên 3D Viewer
        if (Math.abs(cur - _lastLoad) > 0.3) {
            _lastLoad = cur;
            const maxA = _currentRange.current_max_A;
            const twin = getTwin();

            if (maxA && maxA > 0) {
                // Có ngưỡng dòng điện hợp lệ từ Settings → tính % tải thật
                const loadPct = Math.min(150, (cur / maxA) * 100);
                if (twin) twin.updateLoad(loadPct);

                const lp = document.getElementById('loadPill');
                if (lp) {
                    lp.textContent = loadPct > 90 ? `🔴 ${cur.toFixed(1)}A` : 
                                    loadPct > 70 ? `🟡 ${cur.toFixed(1)}A` :
                                    `🟢 ${cur.toFixed(1)}A`;
                }
            } else {
                // Chưa cấu hình ngưỡng dòng điện (normal_current_max_A) trong Settings
                // → không đoán bừa bằng fallback thấp, giữ nguyên trạng thái idle (xám)
                // để tránh báo "quá tải" giả.
                if (twin) twin.updateLoad(0);
                const lp = document.getElementById('loadPill');
                if (lp) lp.textContent = `⚪ ${cur.toFixed(1)}A`;
            }
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
    } catch (_) { _currentRange = {}; }
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

// ── Window functions ──
window.setAlarmFilter = function (f, btn) {
    _almFilter = f;
    document.querySelectorAll('.af-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _renderAlarms(_filterAlarms(_allAlarms));
};

window.fetchAlarms = fetchAlarms;
window.resolveAlarm = resolveAlarm;
