/**
 * js/settings.js
 * Logic cho trang Settings (Cau Hinh): Machine Tuning (steps/speed/acc/travel/
 * homing), AI Provider (switch), Network status, Theme (ISA-101 color picker),
 * doi mat khau, export YAML.
 */

import { auth } from '/static/js/auth.js';
import { theme } from '/static/js/theme.js';
import { api } from '/static/js/api.js';
import { initAiChat, initSidebarStatus, initUserBar, initLogout, refreshProviderBadge } from '/static/js/ai_chat.js';

// Apply theme ngay
theme.init({ syncFromCloud: true });

document.addEventListener('DOMContentLoaded', async () => {
    if (!auth.guard()) return;

    initUserBar(auth);
    initLogout(auth);
    initSidebarStatus();
    initAiChat();

    document.getElementById('nav-settings')?.classList.add('active');

    setInterval(() => { const el = document.getElementById('pageClk'); if (el) el.textContent = new Date().toLocaleTimeString('vi-VN'); }, 1000);

    await loadMachine();
    await fetchProvStatus();
    await fetchNetwork();
    _syncThemeInputs();
});

// ══ Machine config ══
// ⭐ SỬA NGƯỠNG DÒNG ĐIỆN MẶC ĐỊNH CHO ĐÚNG VỚI ĐỘNG CƠ THỰC TẾ
const DEFAULTS_MACHINE = { 
    steps_x: 80, 
    steps_y: 80, 
    steps_z: 80, 
    max_speed_x: 250, 
    max_speed_y: 250, 
    max_speed_z: 150, 
    acc_x: 1000, 
    acc_y: 1000, 
    acc_z: 800, 
    max_travel_x: 300, 
    max_travel_y: 200, 
    max_travel_z: 100, 
    enable_homing: true, 
    homing_speed: 50, 
    homing_pulloff: 5, 
    // ⭐ TĂNG NGƯỠNG DÒNG ĐIỆN (thay đổi theo động cơ của bạn)
    normal_current_min_A: 0.5,   // Dòng idle tối thiểu
    normal_current_max_A: 5.0,   // Dòng tối đa (mặc định 8A, chỉnh theo động cơ)
    spindle_max_rpm: 12000 
};

let cfg = { ...DEFAULTS_MACHINE };

async function loadMachine() {
    try {
        const d = await api.get('/api/settings/machine');
        // ⭐ Merge với default, đảm bảo các key mới được thêm vào
        cfg = { ...DEFAULTS_MACHINE, ...d };
        _syncParamUI(); 
        _buildYAML();
        _showMsg('machineMsg', '✅ Đã tải cấu hình', 'var(--status-active)');
    } catch (_) { 
        // ⭐ Nếu lỗi, dùng default
        cfg = { ...DEFAULTS_MACHINE };
        _buildYAML(); 
    }
}

async function saveMachine() {
    _showMsg('machineMsg', '💾 Đang lưu...', 'var(--status-warning)');
    try {
        await api.post('/api/settings/machine', cfg);
        _showMsg('machineMsg', '✅ Đã lưu cấu hình máy', 'var(--status-active)');
    } catch (e) { 
        _showMsg('machineMsg', '❌ ' + e.message, 'var(--status-alarm)'); 
    }
}

function resetMachine() {
    if (!confirm('Khôi phục mặc định?')) return;
    cfg = { ...DEFAULTS_MACHINE };
    _syncParamUI(); 
    _buildYAML(); 
    _showMsg('machineMsg', '🔄 Đã khôi phục mặc định', 'var(--status-active)');
}

function exportYAML() {
    const content = document.getElementById('yamlBox').textContent;
    const a = document.createElement('a');
    a.download = `cnc_config_${new Date().toISOString().slice(0, 10)}.yaml`;
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/yaml' }));
    a.click();
}

function _syncParamUI() {
    document.querySelectorAll('.param-val').forEach(el => {
        const m = el.getAttribute('onclick')?.match(/'([^']+)'/);
        if (!m) return;
        const key = m[1], v = cfg[key];
        if (v === undefined) return;
        el.textContent = typeof v === 'boolean' ? String(v) : typeof v === 'number' ? v.toFixed(2) : v;
    });
}

function _buildYAML() {
    document.getElementById('yamlBox').textContent =
`# CNC Machine Configuration — ${new Date().toISOString().slice(0, 10)}
machine_tuning:
  steps_per_mm:
    x: ${cfg.steps_x}
    y: ${cfg.steps_y}
    z: ${cfg.steps_z}
motion:
  max_speed_mm_s:
    x: ${cfg.max_speed_x}
    y: ${cfg.max_speed_y}
    z: ${cfg.max_speed_z}
  acceleration:
    x: ${cfg.acc_x}
    y: ${cfg.acc_y}
    z: ${cfg.acc_z}
travel_limits:
  x: ${cfg.max_travel_x}
  y: ${cfg.max_travel_y}
  z: ${cfg.max_travel_z}
homing:
  enabled: ${cfg.enable_homing}
  speed: ${cfg.homing_speed}
  pull_off: ${cfg.homing_pulloff}
safety:
  current_min_A: ${cfg.normal_current_min_A}
  current_max_A: ${cfg.normal_current_max_A}
  spindle_max_rpm: ${cfg.spindle_max_rpm}`;
}

window.toggleAcc = function (header) {
    header.classList.toggle('open');
    header.nextElementSibling.classList.toggle('open');
};

window.editParam = function (el, key) {
    const inp = document.createElement('input');
    inp.type = 'text'; 
    inp.className = 'param-inp'; 
    inp.value = el.textContent;
    el.style.display = 'none'; 
    el.parentElement.appendChild(inp); 
    inp.focus();
    
    const commit = () => {
        el.style.display = ''; 
        inp.remove();
        let v = inp.value.trim();
        if (key === 'enable_homing') v = (v === 'true' || v === '1');
        else if (!isNaN(parseFloat(v))) v = parseFloat(v);
        cfg[key] = v;
        el.textContent = typeof v === 'boolean' ? String(v) : typeof v === 'number' ? v.toFixed(2) : v;
        _buildYAML();
    };
    
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => { 
        if (e.key === 'Enter') commit(); 
        if (e.key === 'Escape') { el.style.display = ''; inp.remove(); } 
    });
};

window.saveMachine = saveMachine;
window.resetMachine = resetMachine;
window.exportYAML = exportYAML;

// ══ AI Provider ══
let _selProv = '';

async function fetchProvStatus() {
    try {
        const d = await api.get('/api/ai/provider/status');
        const tier = d.tier || 'cloud', prov = d.provider || 'gemini';
        
        // ⭐ Cập nhật tất cả badge trên toàn trang
        document.querySelectorAll('#aiProvBadge').forEach(el => {
            el.textContent = `${prov} ▾`;
        });
        document.querySelectorAll('#aiTierLbl, #aiTier').forEach(el => {
            el.textContent = `tier: ${tier}`;
        });
        
        // Cập nhật settings
        const pill = document.getElementById('tierPill');
        if (pill) {
            pill.textContent = tier;
            pill.className = `tier-pill ${tier === 'cloud' ? 'tier-cloud' : tier === 'local' ? 'tier-local' : 'tier-emergency'}`;
        }
        document.getElementById('provNameLbl').textContent = prov;
        document.querySelectorAll('.prov-card').forEach(c => {
            c.classList.toggle('active', c.getAttribute('data-p') === prov);
        });
        
        _showMsg('aiMsg', `✅ Tier: ${tier} | ${prov}`, 'var(--status-active)');
    } catch (e) { 
        _showMsg('aiMsg', '❌ ' + e.message, 'var(--status-alarm)'); 
    }
}

window.selectProv = function (card) {
    document.querySelectorAll('.prov-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active'); 
    _selProv = card.getAttribute('data-p');
};

async function switchProv() {
    if (!_selProv) { alert('Chọn provider trước'); return; }
    _showMsg('aiMsg', `⚡ Đang chuyển sang ${_selProv}...`, 'var(--status-warning)');
    try {
        const r = await api.post('/api/ai/provider/switch', { provider: _selProv });
        _showMsg('aiMsg', '✅ ' + r.message, 'var(--status-active)');
        
        // ⭐ Cập nhật badge trên toàn trang
        if (typeof refreshProviderBadge === 'function') {
            await refreshProviderBadge();
        } else {
            setTimeout(fetchProvStatus, 1000);
        }
    } catch (e) { 
        _showMsg('aiMsg', '❌ ' + e.message, 'var(--status-alarm)'); 
    }
}

window.switchProv = switchProv;
window.fetchProvStatus = fetchProvStatus;

// ══ Network ══
async function fetchNetwork() {
    try {
        const d = await api.get('/api/settings/network');
        const edgeEl = document.getElementById('edgeStatusVal');
        edgeEl.innerHTML = d.edge_online ? '<span class="dot-on"></span>Online' : '<span class="dot-off"></span>Offline';
        document.getElementById('lastSyncVal').textContent = d.last_data_sync ? new Date(d.last_data_sync).toLocaleString('vi-VN') : '—';
        document.getElementById('totalRecVal').textContent = d.sensor_records_total?.toLocaleString('vi-VN') || '—';
    } catch (_) { 
        document.getElementById('edgeStatusVal').innerHTML = '<span class="dot-off"></span>Không kết nối'; 
    }
}
window.fetchNetwork = fetchNetwork;

// ══ Theme ══
const DEFAULTS_THEME = { 
    headerBg: '#D0D2D6', 
    sidebarBg: '#BABCBF', 
    cardBg: '#D0D2D6', 
    accentColor: '#1E5FA8', 
    textColor: '#1A1A1A', 
    borderColor: '#9A9C9F' 
};
const _themeInputs = ['headerBg', 'sidebarBg', 'cardBg', 'accentColor', 'textColor', 'borderColor'];

function _syncThemeInputs() {
    const t = theme.current();
    _themeInputs.forEach(k => {
        const inp = document.getElementById(k);
        const sw = document.getElementById(`sw-${k}`);
        const v = t[k] || DEFAULTS_THEME[k];
        if (inp) inp.value = v;
        if (sw) sw.style.background = v;
    });
}

window.previewColor = function (key, val) {
    const sw = document.getElementById(`sw-${key}`);
    if (sw) sw.style.background = val;
    theme.previewOne(key, val);
};

window.resetColor = function (key) {
    const def = DEFAULTS_THEME[key]; if (!def) return;
    const inp = document.getElementById(key), sw = document.getElementById(`sw-${key}`);
    if (inp) inp.value = def; 
    if (sw) sw.style.background = def;
    theme.previewOne(key, def);
};

async function saveTheme() {
    const t = {};
    _themeInputs.forEach(k => { const inp = document.getElementById(k); if (inp) t[k] = inp.value; });
    await theme.save(t);
    _showMsg('machineMsg', '✅ Đã lưu theme', 'var(--status-active)');
}

async function resetTheme() {
    if (!confirm('Reset tất cả về mặc định ISA-101?')) return;
    await theme.reset(); 
    _syncThemeInputs();
}

window.saveTheme = saveTheme;
window.resetTheme = resetTheme;

// ══ Password ══
async function changePw() {
    const old = document.getElementById('oldPw').value;
    const nw = document.getElementById('newPw').value;
    const cf = document.getElementById('cfPw').value;
    const msg = document.getElementById('pwMsg'); 
    msg.style.display = 'block';
    
    if (!old || !nw) { 
        _showMsg('pwMsg', '⚠ Nhập đầy đủ', 'var(--status-warning)'); 
        return; 
    }
    if (nw !== cf) { 
        _showMsg('pwMsg', '⚠ Mật khẩu không khớp', 'var(--status-warning)'); 
        return; 
    }
    
    try {
        await api.post('/api/auth/change-password', { old_password: old, new_password: nw });
        _showMsg('pwMsg', '✅ Đã đổi mật khẩu', 'var(--status-active)');
        ['oldPw', 'newPw', 'cfPw'].forEach(id => document.getElementById(id).value = '');
    } catch (e) { 
        _showMsg('pwMsg', '❌ ' + e.message, 'var(--status-alarm)'); 
    }
}
window.changePw = changePw;

// ── Helper ──
function _showMsg(id, msg, color) {
    const el = document.getElementById(id); 
    if (!el) return;
    el.textContent = msg; 
    el.style.color = color || 'var(--text-secondary)'; 
    el.style.display = 'block';
}
