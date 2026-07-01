/**
 * js/control.js
 * Logic cho trang Control (Dieu Khien): toggle Manual/Auto, machine status
 * realtime, danh sach G-code (confirm/run/preview), quick actions (home/stop/
 * resume/unlock), ESTOP, Jog.
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout } from '/static/js/ai_chat.js';
import { DigitalTwinViewer } from '/static/js/digital_twin.js';

// ⭐ 1. KHỞI TẠO THEME
theme.init();

// ⭐ 2. HELPER FUNCTIONS
function _el(id) { return document.getElementById(id); }
function _showCtrlMsg(msg, color) { 
    const el = document.getElementById('ctrlMsg'); 
    if (el) { 
        el.textContent = msg; 
        el.style.color = color || 'var(--text-secondary)'; 
    } 
}

// ⭐ 3. DIGITAL TWIN VIEWER
const twin = new DigitalTwinViewer('toolpathFrame');
twin.onToolpathRendered((points) => {
    const el = document.getElementById('toolpathStatus');
    if (el) el.textContent = `✅ Đã vẽ toolpath (${points} điểm)`;
});

// ⭐ 4. DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat({ enableUpload: true, enableGcodeActions: true, onAfterChat: fetchGcodeList });

    fetchMachineStatus(); 
    setInterval(fetchMachineStatus, 3000);
    fetchGcodeList();
    initFluidncConnection();

    if (window.location.hash === '#ai') setMode('auto');
});

// ── FluidNC WebUI ──────────────────────────────────────────────────────────
const KEY_FLUIDNC_LAST  = 'cnc_fluidnc_url';
const KEY_FLUIDNC_SAVED = 'cnc_fluidnc_saved_urls';

function _fluidncSavedUrls() {
    try { return JSON.parse(localStorage.getItem(KEY_FLUIDNC_SAVED) || '[]'); }
    catch { return []; }
}

function _fluidncRenderSaved() {
    const wrap = document.getElementById('savedUrlsList');
    if (!wrap) return;
    const urls = _fluidncSavedUrls();
    if (!urls.length) {
        wrap.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Chưa có URL nào được lưu</span>';
        return;
    }
    wrap.innerHTML = urls.map(u => `
        <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:var(--gray-sidebar);border:1px solid var(--gray-border);border-radius:12px;font-size:10px;font-family:monospace;">
            <span style="cursor:pointer;color:var(--cyan-portal);" onclick="quickConnect('${u}')">${u}</span>
            <span style="cursor:pointer;color:var(--status-alarm);" onclick="removeSavedUrl('${u}')">✖</span>
        </span>
    `).join('');
}

function _fluidncSaveUrl(url) {
    const urls = _fluidncSavedUrls();
    if (!urls.includes(url)) {
        urls.unshift(url);
        localStorage.setItem(KEY_FLUIDNC_SAVED, JSON.stringify(urls.slice(0, 8)));
        _fluidncRenderSaved();
    }
}

window.removeSavedUrl = function (url) {
    const urls = _fluidncSavedUrls().filter(u => u !== url);
    localStorage.setItem(KEY_FLUIDNC_SAVED, JSON.stringify(urls));
    _fluidncRenderSaved();
};

function initFluidncConnection() {
    _fluidncRenderSaved();
    const last = localStorage.getItem(KEY_FLUIDNC_LAST);
    if (last) {
        document.getElementById('deviceUrl').value = last;
        _fluidncLoad(last);
    }
}

function _fluidncNormalize(raw) {
    let url = raw.trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url;
}

function _fluidncSetStatus(state, url = '') {
    const badge = document.getElementById('connectionStatus');
    const dot   = document.getElementById('manualStatusDot');
    const text  = document.getElementById('manualStatusText');
    const urlEl = document.getElementById('manualStatusUrl');

    const map = {
        connecting:   { label: 'Đang kết nối...', color: 'var(--status-warning)' },
        connected:    { label: 'Đã kết nối',      color: 'var(--status-active)'  },
        error:        { label: 'Lỗi kết nối',     color: 'var(--status-alarm)'   },
        disconnected: { label: 'Chưa kết nối',    color: 'var(--text-muted)'     },
    };
    const s = map[state] || map.disconnected;

    if (badge) { badge.textContent = s.label; badge.style.color = s.color; }
    if (dot)   dot.style.background = s.color;
    if (text)  text.textContent = s.label;
    if (urlEl) urlEl.textContent = url;
}

function _fluidncLoad(url) {
    const frame   = document.getElementById('fluidncFrame');
    const empty   = document.getElementById('manualEmpty');
    const loading = document.getElementById('manualLoading');
    const error   = document.getElementById('manualError');

    empty.style.display   = 'none';
    error.style.display   = 'none';
    loading.style.display = 'flex';
    frame.style.display   = 'none';

    _fluidncSetStatus('connecting', url);
    frame.src = url;
}

window.connectToDevice = function () {
    const input = document.getElementById('deviceUrl');
    const url = _fluidncNormalize(input.value);
    if (!url) { _fluidncSetStatus('disconnected'); return; }

    localStorage.setItem(KEY_FLUIDNC_LAST, url);
    _fluidncSaveUrl(url);
    _fluidncLoad(url);
};

window.quickConnect = function (url) {
    document.getElementById('deviceUrl').value = url;
    localStorage.setItem(KEY_FLUIDNC_LAST, url);
    _fluidncSaveUrl(url);
    _fluidncLoad(url);
};

window.retryManual = function () {
    const last = localStorage.getItem(KEY_FLUIDNC_LAST);
    if (last) _fluidncLoad(last);
};

window.openConnectionInNewTab = function () {
    const url = localStorage.getItem(KEY_FLUIDNC_LAST) || _fluidncNormalize(document.getElementById('deviceUrl').value);
    if (url) window.open(url, '_blank');
};

window.closeConnection = function () {
    const frame = document.getElementById('fluidncFrame');
    frame.src = 'about:blank';
    frame.style.display = 'none';
    document.getElementById('manualLoading').style.display = 'none';
    document.getElementById('manualError').style.display = 'none';
    document.getElementById('manualEmpty').style.display = 'flex';
    localStorage.removeItem(KEY_FLUIDNC_LAST);
    _fluidncSetStatus('disconnected');
};

window.onManualFrameLoad = function () {
    document.getElementById('manualLoading').style.display = 'none';
    document.getElementById('fluidncFrame').style.display = 'block';
    const url = localStorage.getItem(KEY_FLUIDNC_LAST) || '';
    _fluidncSetStatus('connected', url);
};

window.onManualFrameError = function () {
    document.getElementById('manualLoading').style.display = 'none';
    document.getElementById('fluidncFrame').style.display = 'none';
    document.getElementById('manualErrMsg').textContent =
        'Không thể tải giao diện FluidNC. Kiểm tra lại IP/URL và đảm bảo bạn đang cùng mạng LAN với máy CNC.';
    document.getElementById('manualError').style.display = 'flex';
    _fluidncSetStatus('error');
};

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

// ===== G-CODE từ AI =====
let currentGCode = '';

function setGCodeFromAI(gcode) {
    currentGCode = gcode;
    const preview = document.getElementById('gcodePreview');
    if (preview) {
        preview.innerHTML = `<pre style="margin:0;white-space:pre-wrap;font-size:10px;">${gcode}</pre>`;
    }
    const btn = document.getElementById('downloadBtn');
    if (btn) btn.disabled = false;
    twin.renderToolpath(gcode);
}

function downloadGCode() {
    if (!currentGCode) { alert('Chưa có G-Code'); return; }
    const a = document.createElement('a');
    a.download = `cnc_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.nc`;
    a.href = URL.createObjectURL(new Blob([currentGCode], { type: 'text/plain' }));
    a.click();
}

function clearGCode() {
    currentGCode = '';
    const preview = document.getElementById('gcodePreview');
    if (preview) preview.innerHTML = '⏳ Chưa có G-Code';
    const btn = document.getElementById('downloadBtn');
    if (btn) btn.disabled = true;
    twin.clearToolpath();
    const info = document.getElementById('tp3dInfo');
    const overlay = document.getElementById('tp3dOverlay');
    if (info) info.textContent = 'Chưa có G-Code';
    if (overlay) overlay.style.display = 'flex';
}

async function sendGcodeToQueue() {
    if (!currentGCode) { alert('Chưa có G-Code để gửi'); return; }
    try {
        await api.post('/api/gcode/save', {
            content: currentGCode,
            source: 'ai',
            filename: `ai_gcode_${Date.now()}.nc`
        });
        _showCtrlMsg('✅ Đã gửi G-code vào queue', 'var(--status-active)');
        fetchGcodeList();
    } catch (e) {
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
}

// ===== NẠP FILE G-CODE =====
document.addEventListener('DOMContentLoaded', () => {
    const gcFileInput = document.getElementById('gcFileInput');
    const gcUploadArea = document.getElementById('gcUploadArea');

    if (gcUploadArea) {
        gcUploadArea.addEventListener('dragover', e => {
            e.preventDefault();
            gcUploadArea.classList.add('dragover');
        });
        gcUploadArea.addEventListener('dragleave', () => gcUploadArea.classList.remove('dragover'));
        gcUploadArea.addEventListener('drop', e => {
            e.preventDefault();
            gcUploadArea.classList.remove('dragover');
            if (e.dataTransfer.files[0]) loadGCodeFile(e.dataTransfer.files[0]);
        });
    }

    if (gcFileInput) {
        gcFileInput.addEventListener('change', e => {
            if (e.target.files[0]) loadGCodeFile(e.target.files[0]);
        });
    }

    const slider = document.getElementById('simSpeedSlider');
    const speedVal = document.getElementById('simSpeedValue');
    if (slider && speedVal) {
        slider.addEventListener('input', () => {
            speedVal.textContent = parseFloat(slider.value).toFixed(1) + 'x';
        });
    }
});

function loadGCodeFile(file) {
    if (!/\.(nc|gcode|txt|tap|cnc|ngc)$/i.test(file.name)) {
        _showCtrlMsg('⚠️ Định dạng không hỗ trợ', 'var(--status-warning)');
        return;
    }
    const r = new FileReader();
    r.onload = e => {
        const text = e.target.result;
        currentGCode = text;
        const preview = document.getElementById('gcodePreview');
        if (preview) {
            preview.innerHTML = `<pre style="margin:0;white-space:pre-wrap;font-size:10px;">${text.slice(0,800)}${text.length>800?'\n...(còn nữa)':''}</pre>`;
        }
        const btn = document.getElementById('downloadBtn');
        if (btn) btn.disabled = false;

        const gcFileName = document.getElementById('gcFileName');
        const gcLineCount = document.getElementById('gcLineCount');
        const gcFileInfo = document.getElementById('gcFileInfo');
        const askAiBtn = document.getElementById('askAiBtn');

        if (gcFileName) gcFileName.textContent = `📄 ${file.name}`;
        if (gcLineCount) gcLineCount.textContent = `${text.split('\n').length} dòng · ${(file.size/1024).toFixed(1)} KB`;
        if (gcFileInfo) gcFileInfo.style.display = 'block';
        if (askAiBtn) askAiBtn.style.display = 'block';

        twin.renderToolpath(text);
        _showCtrlMsg(`✅ Đã nạp ${file.name}`, 'var(--status-active)');
    };
    r.readAsText(file);
}

function askAiAboutGCode() {
    if (!currentGCode) return;
    const input = document.getElementById('aiIn');
    if (input) {
        input.value = 'Hãy phân tích và tối ưu G-Code này cho tôi';
        input.focus();
    }
}

// Stub functions
function tp3dToggleGrid() { toggleTpBtn('btnTpGrid'); }
function tp3dToggleAxes() { toggleTpBtn('btnTpAxes'); }
function tp3dToggleBox()  { toggleTpBtn('btnTpBox'); }
function tp3dResetView()  {}
function tp3dSimulate()   {}
function tp3dStop()       {}
function tp3dResetSim()   {}
function toggleTpBtn(id)  {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active');
}

// ===== EXPORT =====
window.setGCodeFromAI   = setGCodeFromAI;
window.downloadGCode    = downloadGCode;
window.clearGCode       = clearGCode;
window.sendGcodeToQueue = sendGcodeToQueue;
window.loadGCodeFile    = loadGCodeFile;
window.askAiAboutGCode  = askAiAboutGCode;
window.tp3dToggleGrid   = tp3dToggleGrid;
window.tp3dToggleAxes   = tp3dToggleAxes;
window.tp3dToggleBox    = tp3dToggleBox;
window.tp3dResetView    = tp3dResetView;
window.tp3dSimulate     = tp3dSimulate;
window.tp3dStop         = tp3dStop;
window.tp3dResetSim     = tp3dResetSim;
