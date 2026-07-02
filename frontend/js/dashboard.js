/**
 * js/dashboard.js
 * Logic cho trang Home (base.html): highlight nav theo URL, ctx bar tren AI
 * panel ("HOME", "GIAM SAT REALTIME"...), status edge/alarm tren home-status-bar,
 * dong ho he thong.
 *
 * AI Chat panel dung component dung chung js/ai_chat.js voi enableGcodeActions
 * (vi tu Home cung co the chat AI va luu G-code AI sinh ra).
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout } from '/static/js/ai_chat.js';

theme.init();

document.addEventListener('DOMContentLoaded', () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initAiChat({ enableUpload: true, enableGcodeActions: true });

    _highlightNav();
    _setCtx();

    _fetchHomeStatus();
    initSidebarStatus(15000);
    setInterval(_fetchHomeStatus, 15000);

    setInterval(() => {
        const el = document.getElementById('hClock');
        if (el) el.textContent = new Date().toLocaleTimeString('vi-VN');
    }, 1000);
});

// ── Nav highlight + ctx bar ──────────────────────────────────────────────
function _highlightNav() {
    const path = window.location.pathname;
    const map = { '/': 'nav-home', '/monitor': 'nav-monitor', '/control': 'nav-control', '/history': 'nav-history', '/settings': 'nav-settings' };
    Object.entries(map).forEach(([p, id]) => {
        const el = document.getElementById(id); if (!el) return;
        el.classList.toggle('active', p === '/' ? path === '/' : path.startsWith(p));
    });
}

function _setCtx() {
    const path = window.location.pathname;
    const map = { '/': 'HOME', '/monitor': 'GIÁM SÁT REALTIME', '/control': 'ĐIỀU KHIỂN + G-CODE', '/history': 'LỊCH SỬ DỮ LIỆU', '/settings': 'CẤU HÌNH HỆ THỐNG' };
    const el = document.getElementById('aiCtx'); if (!el) return;
    for (const [p, label] of Object.entries(map)) {
        if (p === '/' ? path === '/' : path.startsWith(p)) { el.textContent = label; break; }
    }
}

// ── Home status widgets (Machine Status / Network / Health card) ─────────
async function _fetchHomeStatus() {
    try {
        const d = await api.get('/api/monitor/status');
        const online = d.sensor?.online;
        const n = d.alarms?.unresolved || 0, c = d.alarms?.critical || 0;

        const hd = document.getElementById('hEdgeDot'), ht = document.getElementById('hEdgeTxt');
        if (hd) {
            hd.style.background = online ? 'var(--status-active)' : 'var(--status-alarm)';
            hd.style.animation = online ? 'pulse 2s infinite' : 'none';
            ht.textContent = online ? 'Hệ thống hoạt động' : 'Edge offline';
        }
        const ha = document.getElementById('hAlmTxt');
        if (ha) {
            ha.textContent = c > 0 ? `🚨 ${c} critical` : n > 0 ? `⚠️ ${n} alarm` : '✅ Không có alarm';
            ha.style.color = c > 0 ? 'var(--status-alarm)' : n > 0 ? '#886600' : 'var(--status-active)';
        }
    } catch (_) {}
}