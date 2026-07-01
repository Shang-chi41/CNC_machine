/**
 * js/history.js
 * Logic cho trang History (Lich Su): 4 tab Sensor/Alarm/G-code/Chat, moi tab
 * tu load du lieu khi duoc kich hoat (lazy-load).
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { createLineChart } from '/static/js/charts.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout } from '/static/js/ai_chat.js';

theme.init();

document.addEventListener('DOMContentLoaded', () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat();

    document.getElementById('nav-history')?.classList.add('active');
    setInterval(() => { const el = document.getElementById('pageClk'); if (el) el.textContent = new Date().toLocaleTimeString('vi-VN'); }, 1000);

    fetchSensor(); // tab mac dinh
});

// ══ Tabs ══
window.switchTab = function (tab, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    const loaders = { sensor: fetchSensor, alarm: fetchAlarms, gcode: fetchGcode, chat: fetchChat };
    loaders[tab]?.();
};

// ══ SENSOR ══
let _sensorChart, _cVel, _cMom, _cCur;
function _initSensorChart() {
    _sensorChart = createLineChart('sensorChart', [
        { label: 'X', color: '#e74c3c' },
        { label: 'Y', color: '#00b894' },
        { label: 'Z', color: '#3498db' },
    ], { maxTicks: 8, fontSize: 9 });

    // Khởi tạo thêm 3 chart mới nếu canvas tồn tại
    if (document.getElementById('chartVel')) {
        _cVel = createLineChart('chartVel', [
            { label: 'Vx', color: '#e74c3c' },
            { label: 'Vy', color: '#00b894' },
            { label: 'Vz', color: '#3498db' },
        ], { maxTicks: 8, fontSize: 9 });
    }
    if (document.getElementById('chartMom')) {
        _cMom = createLineChart('chartMom', [
            { label: 'Mx', color: '#e74c3c' },
            { label: 'My', color: '#00b894' },
            { label: 'Mz', color: '#3498db' },
        ], { maxTicks: 8, fontSize: 9 });
    }
    if (document.getElementById('chartCur')) {
        _cCur = createLineChart('chartCur', [
            { label: 'I(A)', color: '#f39c12' },
        ], { maxTicks: 8, fontSize: 9 });
    }
}

async function fetchSensor() {
    if (!_sensorChart) _initSensorChart();
    const minutes = document.getElementById('sensorRange')?.value || 1440;
    const source = document.getElementById('sensorSource')?.value || 'physical';
    const ep = source === 'virtual' ? '/api/monitor/simulation/history' : '/api/monitor/sensor/history';
    try {
        const data = await api.get(ep, { minutes, limit: 500 });
        document.getElementById('cnt-sensor').textContent = data.length;
        _renderSensorTable(data);
        _renderSensorChart(data);
        _renderSensorSummary(data);
    } catch (e) {
        document.getElementById('sensorBody').innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">❌</div>${e.message}</div></td></tr>`;
    }
}

function _renderSensorChart(data) {
    if (!_sensorChart) return;

    // Clear all charts
    const charts = [_sensorChart, _cVel, _cMom, _cCur].filter(Boolean);
    charts.forEach(c => {
        c.data.labels = [];
        c.data.datasets.forEach(d => d.data = []);
    });

    data.forEach(d => {
        const ts = d.timestamp || d.mqtt_timestamp || d.created_at || '';
        let t = '';
        try { t = new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); } catch (_) { t = ts.slice(11, 16); }
        const axes = d.axes || {};

        // Position chart
        _sensorChart.data.labels.push(t);
        _sensorChart.data.datasets[0].data.push(axes.x?.position ?? d.vi_tri_x ?? d.position?.x ?? 0);
        _sensorChart.data.datasets[1].data.push(axes.y?.position ?? d.vi_tri_y ?? d.position?.y ?? 0);
        _sensorChart.data.datasets[2].data.push(axes.z?.position ?? d.vi_tri_z ?? d.position?.z ?? 0);

        // Velocity chart
        if (_cVel) {
            _cVel.data.labels.push(t);
            _cVel.data.datasets[0].data.push(+(axes.x?.velocity ?? d.van_toc_x ?? 0));
            _cVel.data.datasets[1].data.push(+(axes.y?.velocity ?? d.van_toc_y ?? 0));
            _cVel.data.datasets[2].data.push(+(axes.z?.velocity ?? d.van_toc_z ?? 0));
        }

        // Moment chart
        if (_cMom) {
            _cMom.data.labels.push(t);
            _cMom.data.datasets[0].data.push(+(axes.x?.torque ?? d.moment_x ?? 0));
            _cMom.data.datasets[1].data.push(+(axes.y?.torque ?? d.moment_y ?? 0));
            _cMom.data.datasets[2].data.push(+(axes.z?.torque ?? d.moment_z ?? 0));
        }

        // Current chart
        if (_cCur) {
            _cCur.data.labels.push(t);
            _cCur.data.datasets[0].data.push(+(d.current?.rms ?? d.load ?? 0));
        }
    });

    charts.forEach(c => c.update());
}

function _renderSensorSummary(data) {
    if (!data.length) return;
    const last = data[data.length - 1];
    const axes = last.axes || {};
    document.getElementById('sumX').textContent = (axes.x?.position ?? last.vi_tri_x ?? 0).toFixed(2);
    document.getElementById('sumY').textContent = (axes.y?.position ?? last.vi_tri_y ?? 0).toFixed(2);
    document.getElementById('sumZ').textContent = (axes.z?.position ?? last.vi_tri_z ?? 0).toFixed(2);
    document.getElementById('sumI').textContent = (last.current?.rms ?? last.load ?? 0).toFixed(2) + 'A';
    document.getElementById('sumCount').textContent = data.length;
}

function _renderSensorTable(data) {
    const body = document.getElementById('sensorBody');
    if (!data.length) { body.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">📭</div>Không có dữ liệu</div></td></tr>`; return; }
    body.innerHTML = data.slice(-100).reverse().map(d => {
        const axes = d.axes || {}, ts = d.timestamp || d.mqtt_timestamp || d.created_at || '';
        let t = ''; try { t = new Date(ts).toLocaleString('vi-VN'); } catch (_) { t = ts; }
        const px = +(axes.x?.position ?? d.vi_tri_x ?? 0), py = +(axes.y?.position ?? d.vi_tri_y ?? 0), pz = +(axes.z?.position ?? d.vi_tri_z ?? 0);
        const vx = +(axes.x?.velocity ?? d.van_toc_x ?? 0), vy = +(axes.y?.velocity ?? d.van_toc_y ?? 0), vz = +(axes.z?.velocity ?? d.van_toc_z ?? 0);
        const cur = +(d.current?.rms ?? d.load ?? 0);
        const st = d.status || '—';
        const stBadge = st === 'Run' ? `<span class="badge b-exec">${st}</span>` : st === 'Alarm' ? `<span class="badge b-crit">${st}</span>` : st;
        return `<tr>
            <td class="mono" style="white-space:nowrap;font-size:10px;">${t}</td>
            <td class="mono">${px.toFixed(2)}</td><td class="mono">${py.toFixed(2)}</td><td class="mono">${pz.toFixed(2)}</td>
            <td class="mono">${vx.toFixed(2)}</td><td class="mono">${vy.toFixed(2)}</td><td class="mono">${vz.toFixed(2)}</td>
            <td class="mono">${cur.toFixed(2)}</td>
            <td>${stBadge}</td>
        </tr>`;
    }).join('');
}

window.fetchSensor = fetchSensor;

// ══ ALARM ══
async function fetchAlarms() {
    const level = document.getElementById('alarmLevel')?.value || '';
    const resolved = document.getElementById('alarmResolved')?.value;
    const params = { limit: 200 };
    if (level) params.level = level;
    if (resolved) params.resolved = resolved;
    try {
        const data = await api.get('/api/monitor/alarms', params);
        document.getElementById('cnt-alarm').textContent = data.length;
        const crit = data.filter(a => a.level === 'critical' && !a.resolved).length;
        const warn = data.filter(a => a.level === 'warning' && !a.resolved).length;
        const done = data.filter(a => a.resolved).length;
        document.getElementById('almCrit').textContent = crit;
        document.getElementById('almWarn').textContent = warn;
        document.getElementById('almDone').textContent = done;
        document.getElementById('almTotal').textContent = data.length;
        _renderAlarmTable(data);
    } catch (e) {
        document.getElementById('alarmBody').innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">❌</div>${e.message}</div></td></tr>`;
    }
}

function _renderAlarmTable(data) {
    const body = document.getElementById('alarmBody');
    if (!data.length) { body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">✅</div>Không có alarm</div></td></tr>`; return; }
    body.innerHTML = data.map(a => {
        const level = (a.level || '').toLowerCase();
        const lvlBadge = level === 'critical' ? `<span class="badge b-crit">🛑 Critical</span>` : level === 'emergency' ? `<span class="badge b-emerg">🆘 Emergency</span>` : `<span class="badge b-warn">⚠ Warning</span>`;
        const stBadge = a.resolved ? `<span class="badge b-ok">✅ Đã xử lý</span>` : `<span class="badge b-pending">⏳ Chờ</span>`;
        let ts = ''; try { ts = new Date(a.created_at).toLocaleString('vi-VN'); } catch (_) { ts = a.created_at || ''; }
        const src = a.source || 'edge';
        const resolveBtn = !a.resolved
            ? `<button class="tbl-btn success" onclick="resolveAlarm('${a._id}',this)">✓ Xử lý</button>`
            : '<span style="color:var(--text-muted);font-size:9px;">—</span>';
        return `<tr>
            <td>${lvlBadge}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${a.message || ''}">${a.message || '—'}</td>
            <td><span style="font-size:10px;color:var(--text-muted);">${src}</span></td>
            <td class="mono" style="font-size:10px;white-space:nowrap;">${ts}</td>
            <td>${stBadge}</td>
            <td>${resolveBtn}</td>
        </tr>`;
    }).join('');
}

async function resolveAlarm(id, btn) {
    btn.disabled = true; btn.textContent = '...';
    try { await api.post(`/api/monitor/alarms/${id}/resolve`); fetchAlarms(); }
    catch (e) { btn.disabled = false; btn.textContent = '✓ Xử lý'; alert('Lỗi: ' + e.message); }
}

window.fetchAlarms = fetchAlarms;
window.resolveAlarm = resolveAlarm;

// ══ G-CODE ══
async function fetchGcode() {
    const source = document.getElementById('gcodeSource')?.value || '';
    const status = document.getElementById('gcodeStatus')?.value || '';
    const params = { limit: 100 };
    if (source) params.source = source;
    if (status) params.status = status;
    try {
        const data = await api.get('/api/gcode/history', params);
        document.getElementById('cnt-gcode').textContent = data.length;
        document.getElementById('gcTotal').textContent = data.length;
        document.getElementById('gcExec').textContent = data.filter(g => g.status === 'executed').length;
        document.getElementById('gcPend').textContent = data.filter(g => ['pending_validation', 'pending_confirmation', 'approved'].includes(g.status)).length;
        _renderGcodeTable(data);
    } catch (e) {
        document.getElementById('gcodeBody').innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">❌</div>${e.message}</div></td></tr>`;
    }
}

function _renderGcodeTable(data) {
    const body = document.getElementById('gcodeBody');
    if (!data.length) { body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">📭</div>Không có G-code</div></td></tr>`; return; }
    body.innerHTML = data.map(g => {
        const src = g.source === 'ai' ? `<span class="badge b-ai">🤖 AI</span>` : g.source === 'upload' ? `<span class="badge b-manual">📤 Upload</span>` : `<span class="badge b-manual">✍ Manual</span>`;
        const stMap = { pending_validation: '<span class="badge b-pending">⏳ Validation</span>', pending_confirmation: '<span class="badge b-pending">⏳ Chờ confirm</span>', approved: '<span class="badge b-conf">✔ Duyệt</span>', confirmed: '<span class="badge b-conf">✅ Confirmed</span>', executing: '<span class="badge b-exec">▶ Đang chạy</span>', executed: '<span class="badge b-ok">✅ Đã chạy</span>', rejected: '<span class="badge b-reject">❌ Từ chối</span>' };
        const stBadge = stMap[g.status] || `<span class="badge b-pending">${g.status}</span>`;
        let ts = ''; try { ts = new Date(g.created_at).toLocaleString('vi-VN'); } catch (_) { ts = g.created_at || ''; }
        const canConfirm = ['approved', 'pending_confirmation', 'pending_validation'].includes(g.status);
        const actions = [
            `<button class="tbl-btn" onclick="downloadGcode('${g._id}','${g.filename || 'gcode.nc'}')">⬇ DL</button>`,
            canConfirm ? `<button class="tbl-btn success" onclick="confirmGcode('${g._id}',this)">✓ Confirm</button>` : '',
            g.status !== 'rejected' && g.status !== 'executed' ? `<button class="tbl-btn danger" onclick="rejectGcode('${g._id}',this)">✗ Reject</button>` : '',
        ].filter(Boolean).join(' ');
        return `<tr>
            <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${g.filename || ''}">${g.filename || g._id?.slice(-8) || '—'}</td>
            <td>${src}</td>
            <td>${stBadge}</td>
            <td class="mono">${g.line_count || '—'}</td>
            <td class="mono" style="font-size:10px;white-space:nowrap;">${ts}</td>
            <td style="white-space:nowrap;">${actions}</td>
        </tr>`;
    }).join('');
}

async function downloadGcode(id, filename) {
    try {
        const r = await api.download(`/api/gcode/${id}/download`);
        const text = await r.text();
        const a = document.createElement('a');
        a.download = filename; a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.click();
    } catch (e) { alert('Lỗi download: ' + e.message); }
}
async function confirmGcode(id, btn) {
    btn.disabled = true; btn.textContent = '...';
    try { await api.post(`/api/gcode/${id}/confirm`); fetchGcode(); } catch (e) { btn.disabled = false; btn.textContent = '✓ Confirm'; alert('Lỗi: ' + e.message); }
}
async function rejectGcode(id, btn) {
    if (!confirm('Từ chối G-code này?')) return;
    btn.disabled = true;
    try { await api.post(`/api/gcode/${id}/reject`); fetchGcode(); } catch (e) { btn.disabled = false; alert('Lỗi: ' + e.message); }
}

window.fetchGcode = fetchGcode;
window.downloadGcode = downloadGcode;
window.confirmGcode = confirmGcode;
window.rejectGcode = rejectGcode;

// ══ CHAT ══
let _chatTimer;
function debounceChat() { clearTimeout(_chatTimer); _chatTimer = setTimeout(fetchChat, 500); }

async function fetchChat() {
    const search = document.getElementById('chatSearch')?.value || '';
    const params = { limit: 100 };
    if (search) params.search = search;
    try {
        const data = await api.get('/api/ai/history', params);
        document.getElementById('cnt-chat').textContent = data.length;
        document.getElementById('chatTotal').textContent = data.length;
        _renderChatTable(data);
    } catch (e) {
        document.getElementById('chatBody').innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">❌</div>${e.message}</div></td></tr>`;
    }
}

function _renderChatTable(data) {
    const body = document.getElementById('chatBody');
    if (!data.length) { body.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">💬</div>Không có lịch sử chat</div></td></tr>`; return; }
    body.innerHTML = data.map(c => {
        let ts = ''; try { ts = new Date(c.created_at || c.timestamp).toLocaleString('vi-VN'); } catch (_) { ts = ''; }
        const msg = (c.message || '').slice(0, 100) + (c.message?.length > 100 ? '…' : '');
        const hasGc = c.message?.includes('```gcode') ? '<span class="badge b-ai">G-Code</span>' : '—';
        return `<tr>
            <td class="mono" style="font-size:10px;white-space:nowrap;">${ts}</td>
            <td style="font-size:10px;">${c.username || '—'}</td>
            <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${c.message || ''}">${msg}</td>
            <td>${hasGc}</td>
        </tr>`;
    }).join('');
}

window.fetchChat = fetchChat;
window.debounceChat = debounceChat;
