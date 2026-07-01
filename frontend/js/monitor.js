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
let _currentRange = { current_min_A: 0, current_max_A: 0, _hasData: false };
let _twin = null;

// ── HELPER ──
function _el(id) { return document.getElementById(id); }

function getTwin() {
    return _twin;
}

// ── DOMContentLoaded ──
document.addEventListener('DOMContentLoaded', () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat();

    // Khởi tạo 3D Viewer
    _twin = new DigitalTwinViewer('cncFrame');
    _twin.onReady(() => {
        console.log('✅ 3D Viewer ready on Monitor');
        // ⭐ Gửi load ban đầu = 0 để model hiển thị màu xám idle
        _twin.updateLoad(0);
    });

    fetchLatest();
    setInterval(fetchLatest, 2000);
    fetchAlarms();
    setInterval(fetchAlarms, 10000);
    fetchMachineCtx();
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
        
        // ⭐ DÒNG ĐIỆN HIỆN TẠI (A)
        const cur = +(d.current?.rms ?? d.load ?? 0);
        const feed = +(d.spindle?.load ?? 0);
        const spindle = +(d.spindle?.speed ?? 0);
        const state = d.status || 'unknown';
        const ts = d.timestamp || d.mqtt_timestamp || '';

        // Tính Speed và Torque
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

        // Last update time
        if (ts) try { 
            _el('lastUpdateTime').textContent = new Date(ts).toLocaleTimeString('vi-VN'); 
        } catch (_) {}

        // ⭐⭐⭐ QUAN TRỌNG: TÍNH % TẢI VÀ GỬI LÊN 3D VIEWER ⭐⭐⭐
        const maxA = _currentRange.current_max_A;
        const hasData = _currentRange._hasData;
        
        let loadPct = 0;
        let shouldSendLoad = false;
        
        if (hasData && maxA && maxA > 0) {
            // ⭐ Có dữ liệu từ Settings: tính % tải
            loadPct = Math.min(100, (cur / maxA) * 100);
            shouldSendLoad = true;
        } else {
            // ⭐ Chưa có dữ liệu: gửi 0 để model idle (màu xám)
            loadPct = 0;
            shouldSendLoad = true;
        }

        // ⭐ Gửi load lên 3D Viewer (chỉ khi giá trị thay đổi đáng kể)
        if (shouldSendLoad && Math.abs(cur - _lastLoad) > 0.2) {
            _lastLoad = cur;
            
            const twin = getTwin();
            if (twin) {
                console.log(`📊 Sending load: ${loadPct}% (current: ${cur}A, max: ${maxA || 'N/A'})`);
                twin.updateLoad(loadPct);
            }

            // Cập nhật load pill
            const lp = document.getElementById('loadPill');
            if (lp) {
                if (!hasData || !maxA) {
                    lp.textContent = `⏳ ${cur.toFixed(1)}A (chờ cấu hình)`;
                    lp.style.color = 'var(--text-muted)';
                } else if (loadPct > 100) {
                    lp.textContent = `🔴 ${cur.toFixed(1)}A (QUÁ TẢI)`;
                    lp.style.color = 'var(--status-alarm)';
                } else if (loadPct > 90) {
                    lp.textContent = `🟡 ${cur.toFixed(1)}A (gần ngưỡng)`;
                    lp.style.color = '#886600';
                } else if (loadPct > 70) {
                    lp.textContent = `🟡 ${cur.toFixed(1)}A`;
                    lp.style.color = '#886600';
                } else if (loadPct > 0) {
                    lp.textContent = `🟢 ${cur.toFixed(1)}A`;
                    lp.style.color = 'var(--status-active)';
                } else {
                    lp.textContent = `⚪ ${cur.toFixed(1)}A (idle)`;
                    lp.style.color = 'var(--text-muted)';
                }
            }

            // Cập nhật range badge
            const badge = document.getElementById('rangeBadge');
            if (badge && hasData && maxA) {
                const ratio = cur / maxA;
                badge.textContent = `${_currentRange.current_min_A || 0}–${maxA}A`;
                badge.className = ratio > 1.15 ? 'st-badge alarm' : 
                                 ratio > 0.9 ? 'st-badge warn' : 'st-badge';
            } else if (badge) {
                badge.textContent = '⏳ Đang tải...';
                badge.className = 'st-badge';
            }
        }
    } catch (_) {
        console.warn('⚠️ fetchLatest error:', _);
    }
}

// ── Machine context ──
async function fetchMachineCtx() {
    try {
        const d = await api.get('/api/settings/machine');
        const tool = d.tool_name || d.name || '—';
        const mat = d.material_name || '—';
        
        const minA = d.normal_current_min_A;
        const maxA = d.normal_current_max_A;
        
        if (maxA && maxA > 0) {
            _currentRange = { 
                current_min_A: minA || 0, 
                current_max_A: maxA,
                _hasData: true
            };
            console.log('📊 Machine context loaded:', _currentRange);
        } else {
            _currentRange = { 
                current_min_A: 0, 
                current_max_A: 0,
                _hasData: false
            };
            console.warn('⚠️ No current range data from settings');
        }
        
        _el('toolBadge').textContent = `🔧 ${tool}`;
        _el('matBadge').textContent = `🧱 ${mat}`;
        
    } catch (_) { 
        _currentRange = { 
            current_min_A: 0, 
            current_max_A: 0,
            _hasData: false
        };
        console.warn('⚠️ Cannot load machine context');
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
