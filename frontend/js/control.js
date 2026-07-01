/**
 * js/control.js
 * Logic cho trang Control (Dieu Khien): toggle Manual/Auto, machine status
 * realtime, danh sach G-code (confirm/run/preview), quick actions (home/stop/
 * resume/unlock), ESTOP, Jog.
 *
 * AI Chat panel su dung component dung chung js/ai_chat.js, kich hoat
 * enableUpload + enableGcodeActions vi trang nay can upload anh phoi va
 * luu/preview G-code AI sinh ra.
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout } from '/static/js/ai_chat.js';
import { DigitalTwinViewer } from '/static/js/digital_twin.js';

theme.init();

// Lop trung gian noi chuyen voi iframe toolpath (cnc_viewer.html) — doc lap
// hoan toan voi trang Monitor (xem digital_twin.js de biet giao thuc dung chung).
const twin = new DigitalTwinViewer('toolpathFrame');
twin.onToolpathRendered((points) => {
    const el = document.getElementById('toolpathStatus');
    if (el) el.textContent = `✅ Đã vẽ toolpath (${points} điểm)`;
});

document.addEventListener('DOMContentLoaded', () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat({ enableUpload: true, enableGcodeActions: true, onAfterChat: fetchGcodeList });

    fetchMachineStatus(); setInterval(fetchMachineStatus, 3000);
    fetchGcodeList();

    // Neu co hash #ai -> chuyen sang auto mode
    if (window.location.hash === '#ai') setMode('auto');
});

// ── Mode toggle ───────────────────────────────────────────────────────────
let _mode = 'manual';
window.setMode = function (mode) {
    _mode = mode;
    document.getElementById('modeManual').classList.toggle('active', mode === 'manual');
    document.getElementById('modeAuto').classList.toggle('active', mode === 'auto');
    document.getElementById('btnManual').classList.toggle('active', mode === 'manual');
    document.getElementById('btnAuto').classList.toggle('active', mode === 'auto');
    if (mode === 'auto') fetchGcodeList();
};

// ── Machine status ────────────────────────────────────────────────────────
async function fetchMachineStatus() {
    try {
        const d = await api.get('/api/control/status');
        const state = d.status || '—';
        const pos = d.position || {};
        const curA = d.current_A || 0;

        const dot = document.getElementById('machDot');
        if (dot) dot.className = `ms-dot ${state === 'Run' ? 'on' : state === 'Alarm' ? 'off' : state === 'Hold' ? 'warn' : 'idle'}`;
        _el('machState').textContent = state;
        _el('machPos').textContent = `X:${(pos.x || 0).toFixed(1)} Y:${(pos.y || 0).toFixed(1)} Z:${(pos.z || 0).toFixed(1)}`;

        _el('autoState').textContent = state;
        _el('autoX').textContent = (pos.x || 0).toFixed(2);
        _el('autoY').textContent = (pos.y || 0).toFixed(2);
        _el('autoZ').textContent = (pos.z || 0).toFixed(2);
        _el('autoI').textContent = curA.toFixed(2);

        twin.updateLoad(curA * 20);
    } catch (_) {}
}

// ── G-Code list ───────────────────────────────────────────────────────────
async function fetchGcodeList() {
    try {
        const data = await api.get('/api/gcode/history', { limit: 20 });
        _renderGcodeList(data);
    } catch (e) {
        document.getElementById('gcodeList').innerHTML = `<div class="gc-empty">❌ ${e.message}</div>`;
    }
}

function _renderGcodeList(data) {
    const el = document.getElementById('gcodeList');
    const pending = data.filter(g => ['pending_validation', 'pending_confirmation', 'approved', 'confirmed'].includes(g.status));
    if (!pending.length) { el.innerHTML = '<div class="gc-empty">📭 Không có G-code đang chờ</div>'; return; }
    el.innerHTML = pending.map(g => {
        const stClass = g.status === 'confirmed' ? 'gc-s-conf' : g.status === 'approved' ? 'gc-s-conf' : g.status === 'rejected' ? 'gc-s-rej' : 'gc-s-pend';
        const stLabel = g.status === 'confirmed' ? 'Confirmed' : g.status === 'approved' ? 'Approved' : 'Chờ';
        const canRun = g.status === 'confirmed';
        const canConf = ['approved', 'pending_confirmation', 'pending_validation'].includes(g.status);
        const actions = [
            canConf ? `<button class="gc-btn conf" onclick="confirmGcode('${g._id}',this)">✓ Confirm</button>` : '',
            canRun ? `<button class="gc-btn run" onclick="runGcode('${g._id}',this)">▶ Run</button>` : '',
            `<button class="gc-btn" onclick="previewGcode('${g._id}')">👁</button>`,
        ].filter(Boolean).join('');
        return `<div class="gc-item">
            <span class="gc-name" title="${g.filename || ''}">${g.filename || g._id?.slice(-8) || '—'}</span>
            <span class="gc-status ${stClass}">${stLabel}</span>
            <div class="gc-actions">${actions}</div>
        </div>`;
    }).join('');
}

async function confirmGcode(id, btn) {
    btn.disabled = true; btn.textContent = '...';
    try { await api.post(`/api/gcode/${id}/confirm`); _showCtrlMsg('✅ Đã confirm G-code', 'var(--status-active)'); fetchGcodeList(); }
    catch (e) { btn.disabled = false; btn.textContent = '✓ Confirm'; _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)'); }
}

async function runGcode(id, btn) {
    if (!confirm('Xác nhận chạy G-code này?')) return;
    btn.disabled = true; btn.textContent = '⏳...';
    try { await api.post(`/api/control/run/${id}`); _showCtrlMsg('▶️ Đang chạy G-code...', 'var(--status-active)'); fetchGcodeList(); }
    catch (e) { btn.disabled = false; btn.textContent = '▶ Run'; _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)'); }
}

async function previewGcode(id) {
    document.getElementById('toolpathStatus').textContent = `Đang load G-code ${id.slice(-6)}...`;
    try {
        const doc = await api.get(`/api/gcode/${id}`);
        const content = doc?.gcode || '';
        if (!content) throw new Error('G-code rỗng');
        // Iframe không có JWT nên không tự gọi API được — gửi thẳng nội dung qua DigitalTwinViewer.
        twin.renderToolpath(content);
        document.getElementById('toolpathStatus').textContent = `Đang vẽ toolpath ${id.slice(-6)}...`;
    } catch (e) {
        document.getElementById('toolpathStatus').textContent = `❌ ${e.message}`;
    }
}

window.fetchGcodeList = fetchGcodeList;
window.confirmGcode = confirmGcode;
window.runGcode = runGcode;
window.previewGcode = previewGcode;

// ── Quick actions ─────────────────────────────────────────────────────────
window.sendCmd = async function (action) {
    _showCtrlMsg(`⚡ ${action}...`, 'var(--status-warning)');
    try {
        await api.post(`/api/control/${action}`);
        const msgs = { home: '🏠 Lệnh Home đã gửi', stop: '⏸ Feed Hold đã gửi', resume: '▶️ Resume đã gửi', unlock: '🔓 Unlock đã gửi' };
        _showCtrlMsg(msgs[action] || '✅ OK', 'var(--status-active)');
    } catch (e) { _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)'); }
};

// ── ESTOP ─────────────────────────────────────────────────────────────────
window.sendEstop = async function () {
    if (!confirm('⚠️ DỪNG KHẨN CẤP?\nMáy sẽ dừng ngay lập tức!')) return;
    const btn = document.getElementById('estopFab');
    btn.style.animation = 'pulse 0.3s infinite';
    try {
        await api.post('/api/control/estop');
        _showCtrlMsg('🛑 ESTOP đã gửi — Máy đang dừng', 'var(--status-alarm)');
    } catch (e) { _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)'); }
    btn.style.animation = '';
};

// ── Jog ───────────────────────────────────────────────────────────────────
window.jog = async function (axis, dir) {
    const dist = parseFloat(document.getElementById('jogDist').value) * dir;
    const feed = parseFloat(document.getElementById('jogFeed').value);
    try {
        await api.post('/api/control/jog', { axis, distance: dist, feed });
        _showCtrlMsg(`🎮 Jog ${axis}${dist > 0 ? '+' : ''}${dist}mm F${feed}`, 'var(--status-active)');
    } catch (e) { _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)'); }
};

// ── Helper ────────────────────────────────────────────────────────────────
function _el(id) { return document.getElementById(id); }
function _showCtrlMsg(msg, color) { const el = document.getElementById('ctrlMsg'); if (el) { el.textContent = msg; el.style.color = color || 'var(--text-secondary)'; } }