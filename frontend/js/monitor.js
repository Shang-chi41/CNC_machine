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
let _minutes = 60;

// ── Helper ──
function _el(id) { return document.getElementById(id); }

// ── DOMContentLoaded ──
document.addEventListener('DOMContentLoaded', () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat({ context: 'monitor' });

    twin = new DigitalTwinViewer('cncFrame');
    twin.onReady(() => {
        console.log('✅ 3D Viewer ready on Monitor');
        twin.updateLoad(0);
    });

    fetchLatest();
    setInterval(fetchLatest, 2000);
    fetchAlarms();
    setInterval(fetchAlarms, 10000);
    fetchMachineCtx();
});

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
        _el('curVal').textContent = cur.toFixed(2);
        _el('feedVal').textContent = feed.toFixed(0);
        _el('spindleVal').textContent = spindle.toFixed(0);

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

// ── Window functions ──
window.setTime = function (min, btn) {
    _minutes = min;
    document.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Có thể fetch chart history nếu cần
};

window.setAlarmFilter = function (f, btn) {
    _almFilter = f;
    document.querySelectorAll('.af-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _renderAlarms(_filterAlarms(_allAlarms));
};

window.fetchAlarms = fetchAlarms;
window.resolveAlarm = resolveAlarm;
