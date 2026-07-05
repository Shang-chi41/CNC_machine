/**
 * js/theme.js
 * Quản lý theme ISA-101 — gom toàn bộ theme code đang rải rác
 * trong mọi HTML file vào một chỗ duy nhất.
 *
 * Theme lưu trong localStorage key: 'cnc_theme'
 * Đồng bộ realtime qua window.storage event (đa tab).
 * Có thể sync lên Cloud qua /api/settings/theme.
 *
 * Sử dụng (thêm vào đầu mỗi page script):
 *   import { theme } from '/static/js/theme.js';
 *   theme.init();   // load + apply ngay khi page load
 *
 * Trong settings.html:
 *   theme.openPicker();          // mở modal color picker
 *   theme.save(colorObj);        // lưu theme mới
 *   theme.reset();               // về mặc định ISA-101
 */

import { api } from '/static/js/api.js';

// ── ISA-101 Default (Light Theme — TIA Portal / WinCC style) ─────────────
export const ISA101_DEFAULT = {
    headerBg:    '#D0D2D6',
    sidebarBg:   '#BABCBF',
    cardBg:      '#D0D2D6',
    accentColor: '#1E5FA8',
    textColor:   '#1A1A1A',
    borderColor: '#9A9C9F',
};

// ── CSS variable mapping ──────────────────────────────────────────────────
const VAR_MAP = {
    headerBg:    ['--gray-header'],
    sidebarBg:   ['--gray-sidebar'],
    cardBg:      ['--gray-card'],
    accentColor: ['--cyan-portal', '--cyan'],
    textColor:   ['--text-primary', '--white'],
    borderColor: ['--gray-border'],
};

// ── Core apply ────────────────────────────────────────────────────────────

/**
 * Áp dụng theme object vào CSS variables của :root.
 * @param {object} t - Theme object (có thể partial)
 */
function applyToRoot(t) {
    if (!t) return;
    const root = document.documentElement;
    Object.entries(VAR_MAP).forEach(([key, vars]) => {
        if (!t[key]) return;
        vars.forEach(v => root.style.setProperty(v, t[key]));
    });
}

// ── Theme object ──────────────────────────────────────────────────────────
export const theme = {

    // ── Load & Apply ──────────────────────────────────────────────────────

    /**
     * Đọc theme từ localStorage và apply ngay.
     * Gọi càng sớm càng tốt (trước DOMContentLoaded nếu được)
     * để tránh flash of unstyled content.
     * @returns {object} Theme đang dùng
     */
    load() {
        const saved = localStorage.getItem('cnc_theme');
        if (!saved) return ISA101_DEFAULT;
        try {
            const t = JSON.parse(saved);
            applyToRoot(t);
            return t;
        } catch(_) {
            return ISA101_DEFAULT;
        }
    },

    /**
     * Apply theme object vào CSS variables.
     * @param {object} t - Theme object
     */
    apply(t) {
        applyToRoot(t);
    },

    /**
     * Khởi tạo theme cho page:
     *   1. Load + apply từ localStorage ngay
     *   2. Lắng nghe storage event để sync đa tab
     *   3. (Tùy chọn) Sync từ Cloud API
     *
     * @param {object} options
     * @param {boolean} [options.syncFromCloud=false] - Fetch theme từ server
     */
    async init({ syncFromCloud = false } = {}) {
        // Apply ngay từ localStorage (không cần chờ network)
        this.load();

        // Lắng nghe thay đổi từ tab khác
        window.addEventListener('storage', e => {
            if (e.key === 'cnc_theme' && e.newValue) {
                try { applyToRoot(JSON.parse(e.newValue)); } catch(_) {}
            }
        });

        // Sync từ Cloud (optional, không block UI)
        if (syncFromCloud) {
            try {
                const serverTheme = await api.get('/api/settings/theme');
                if (serverTheme && typeof serverTheme === 'object') {
                    // Merge với default để không thiếu key nào
                    const merged = { ...ISA101_DEFAULT, ...serverTheme };
                    localStorage.setItem('cnc_theme', JSON.stringify(merged));
                    applyToRoot(merged);
                }
            } catch(_) {
                // Không có internet hoặc chưa login → dùng localStorage
            }
        }
    },

    // ── Save ──────────────────────────────────────────────────────────────

    /**
     * Lưu theme mới: apply ngay + localStorage + Cloud API.
     * @param {object} t - Theme object đầy đủ
     */
    async save(t) {
        // Merge với current để không ghi đè key không có trong t
        const current = this.current();
        const merged  = { ...current, ...t };

        // Apply ngay
        applyToRoot(merged);

        // Lưu localStorage (trigger storage event cho các tab khác)
        localStorage.setItem('cnc_theme', JSON.stringify(merged));

        // Đẩy lên Cloud (không block)
        try {
            await api.post('/api/settings/theme', merged);
        } catch(_) {}

        return merged;
    },

    // ── Reset ─────────────────────────────────────────────────────────────

    /**
     * Khôi phục theme về mặc định ISA-101.
     */
    async reset() {
        await this.save(ISA101_DEFAULT);
        return ISA101_DEFAULT;
    },

    /**
     * Reset một màu về mặc định.
     * @param {string} key - Key trong ISA101_DEFAULT
     */
    async resetOne(key) {
        if (!(key in ISA101_DEFAULT)) return;
        const current   = this.current();
        current[key]    = ISA101_DEFAULT[key];
        await this.save(current);
        return current;
    },

    // ── Getters ───────────────────────────────────────────────────────────

    /**
     * Trả về theme hiện tại từ localStorage (hoặc default).
     * @returns {object}
     */
    current() {
        try {
            const saved = localStorage.getItem('cnc_theme');
            return saved ? { ...ISA101_DEFAULT, ...JSON.parse(saved) } : { ...ISA101_DEFAULT };
        } catch(_) {
            return { ...ISA101_DEFAULT };
        }
    },

    // ── Color Picker UI ───────────────────────────────────────────────────

    /**
     * Render color picker modal vào page.
     * Tạo modal nếu chưa có, toggle show/hide.
     *
     * Cấu trúc modal đã có sẵn trong settings.html —
     * hàm này dùng để mở/đóng từ bất kỳ page nào.
     */
    openPicker() {
        let modal = document.getElementById('colorModal');

        // Nếu chưa có modal → inject vào body (các page không phải settings)
        if (!modal) {
            modal = _createPickerModal();
            document.body.appendChild(modal);
        }

        // Sync input values với theme hiện tại
        const t = this.current();
        _syncPickerInputs(modal, t);

        modal.classList.add('show');
    },

    closePicker() {
        const modal = document.getElementById('colorModal');
        if (modal) modal.classList.remove('show');
    },

    /**
     * Lấy màu từ các input trong picker và save.
     * Dùng khi người dùng bấm nút "LƯU THEME" trong modal.
     */
    async saveFromPicker() {
        const modal = document.getElementById('colorModal');
        if (!modal) return;

        const t = {
            headerBg:    modal.querySelector('#headerBg')?.value    || ISA101_DEFAULT.headerBg,
            sidebarBg:   modal.querySelector('#sidebarBg')?.value   || ISA101_DEFAULT.sidebarBg,
            cardBg:      modal.querySelector('#cardBg')?.value      || ISA101_DEFAULT.cardBg,
            accentColor: modal.querySelector('#accentColor')?.value || ISA101_DEFAULT.accentColor,
            textColor:   modal.querySelector('#textColor')?.value   || ISA101_DEFAULT.textColor,
            borderColor: modal.querySelector('#borderColor')?.value || ISA101_DEFAULT.borderColor,
        };

        await this.save(t);
        this.closePicker();
        return t;
    },

    /**
     * Áp dụng preview realtime khi người dùng đang chọn màu (onChange).
     * @param {string} key   - Key theme (vd: 'accentColor')
     * @param {string} value - Giá trị màu hex
     */
    previewOne(key, value) {
        const partial = {};
        partial[key] = value;
        applyToRoot(partial);

        // Cập nhật preview box trong modal
        const preview = document.getElementById(`preview${_capitalize(key)}`);
        if (preview) preview.style.background = value;
    },
};

// ── Private helpers ───────────────────────────────────────────────────────

function _capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function _syncPickerInputs(modal, t) {
    const fields = ['headerBg', 'sidebarBg', 'cardBg', 'accentColor', 'textColor', 'borderColor'];
    fields.forEach(key => {
        const input   = modal.querySelector(`#${key}`);
        const preview = modal.querySelector(`#preview${_capitalize(key)}`);
        const val     = t[key] || ISA101_DEFAULT[key];
        if (input)   input.value             = val;
        if (preview) preview.style.background = val;
    });
}

/**
 * Tạo color picker modal HTML khi page không phải settings.html.
 * settings.html đã có sẵn modal này trong HTML.
 */
function _createPickerModal() {
    const div = document.createElement('div');
    div.innerHTML = `
<style>
.color-palette-btn{position:fixed;bottom:100px;right:20px;width:52px;height:52px;border-radius:50%;background:var(--cyan-portal);border:2px solid var(--status-warning);box-shadow:var(--card-shadow);cursor:pointer;z-index:1000;display:flex;align-items:center;justify-content:center;font-size:26px;transition:var(--transition);}
.color-palette-btn:hover{transform:scale(1.08);}
.color-modal{position:fixed;bottom:170px;right:20px;width:340px;background:var(--gray-card);border:1px solid var(--gray-border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:1001;display:none;overflow:hidden;}
.color-modal.show{display:block;}
.color-modal-header{padding:12px 16px;background:var(--cyan-portal);color:white;display:flex;justify-content:space-between;align-items:center;font-weight:bold;font-family:'Orbitron',monospace;font-size:12px;}
.color-modal-close{background:none;border:none;color:white;font-size:20px;cursor:pointer;}
.color-modal-content{padding:16px;max-height:400px;overflow-y:auto;}
.color-group-title{font-family:'Orbitron',monospace;font-size:10px;color:var(--cyan-portal);margin:12px 0 8px;letter-spacing:1px;border-bottom:1px solid var(--gray-border);padding-bottom:4px;}
.color-item{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gray-border);}
.color-label{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text-primary);}
.color-preview{width:28px;height:28px;border-radius:6px;border:1px solid var(--gray-border);}
input[type="color"]{width:55px;height:32px;border:1px solid var(--gray-border);border-radius:4px;cursor:pointer;}
.btn-reset-small{background:rgba(0,0,0,0.08);border:1px solid var(--gray-border);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:10px;color:var(--text-secondary);}
.modal-actions{display:flex;gap:12px;margin-top:16px;padding-top:12px;border-top:1px solid var(--gray-border);}
.modal-actions button{flex:1;padding:10px;border-radius:4px;border:none;cursor:pointer;font-weight:bold;font-family:'Orbitron',monospace;font-size:10px;}
.btn-save-theme{background:var(--status-active);color:white;}
.btn-reset-theme{background:var(--gray-sidebar);color:var(--text-primary);border:1px solid var(--gray-border);}
</style>

<div class="color-palette-btn" id="colorPaletteBtn" title="Tùy chỉnh giao diện">🎨</div>

<div class="color-modal" id="colorModal">
    <div class="color-modal-header">
        <span>🎨 TÙY CHỈNH GIAO DIỆN</span>
        <button class="color-modal-close" id="closeModalBtn">✖</button>
    </div>
    <div class="color-modal-content">
        <div class="color-group-title">🏠 HEADER & NAVBAR</div>
        <div class="color-item">
            <div class="color-label"><div class="color-preview" id="previewHeaderBg"></div><span>Header</span></div>
            <input type="color" id="headerBg">
            <button class="btn-reset-small" data-reset="headerBg">↺</button>
        </div>
        <div class="color-item">
            <div class="color-label"><div class="color-preview" id="previewSidebarBg"></div><span>Navbar</span></div>
            <input type="color" id="sidebarBg">
            <button class="btn-reset-small" data-reset="sidebarBg">↺</button>
        </div>
        <div class="color-group-title">📦 CARD</div>
        <div class="color-item">
            <div class="color-label"><div class="color-preview" id="previewCardBg"></div><span>Card Background</span></div>
            <input type="color" id="cardBg">
            <button class="btn-reset-small" data-reset="cardBg">↺</button>
        </div>
        <div class="color-group-title">🎨 ACCENT</div>
        <div class="color-item">
            <div class="color-label"><div class="color-preview" id="previewAccentColor"></div><span>Accent Color</span></div>
            <input type="color" id="accentColor">
            <button class="btn-reset-small" data-reset="accentColor">↺</button>
        </div>
        <div class="color-group-title">📝 TEXT & BORDER</div>
        <div class="color-item">
            <div class="color-label"><div class="color-preview" id="previewTextColor"></div><span>Text</span></div>
            <input type="color" id="textColor">
            <button class="btn-reset-small" data-reset="textColor">↺</button>
        </div>
        <div class="color-item">
            <div class="color-label"><div class="color-preview" id="previewBorderColor"></div><span>Border</span></div>
            <input type="color" id="borderColor">
            <button class="btn-reset-small" data-reset="borderColor">↺</button>
        </div>
        <div class="modal-actions">
            <button class="btn-save-theme" id="saveThemeBtn">💾 LƯU THEME</button>
            <button class="btn-reset-theme" id="resetThemeBtn">⟳ MẶC ĐỊNH</button>
        </div>
    </div>
</div>`;

    document.body.appendChild(div);

    // Event listeners
    const modal   = div.querySelector('#colorModal');
    const openBtn = div.querySelector('#colorPaletteBtn');
    const closeBtn= div.querySelector('#closeModalBtn');

    openBtn.onclick  = () => theme.openPicker();
    closeBtn.onclick = () => theme.closePicker();

    // Preview realtime khi thay đổi màu
    div.querySelectorAll('input[type="color"]').forEach(input => {
        input.addEventListener('input', e => {
            theme.previewOne(e.target.id, e.target.value);
        });
    });

    // Reset từng màu
    div.querySelectorAll('[data-reset]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-reset');
            theme.resetOne(key).then(() => {
                const input = div.querySelector(`#${key}`);
                if (input) input.value = ISA101_DEFAULT[key];
            });
        });
    });

    // Save
    div.querySelector('#saveThemeBtn').onclick = () => theme.saveFromPicker();

    // Reset all
    div.querySelector('#resetThemeBtn').onclick = () => {
        if (confirm('⚠️ Reset tất cả màu về mặc định ISA-101?')) {
            theme.reset().then(() => _syncPickerInputs(modal, ISA101_DEFAULT));
        }
    };

    return modal;
}

// ── Auto-init: apply theme ngay khi script load ───────────────────────────
// (chạy trước DOMContentLoaded để tránh flash)
;(function earlyApply() {
    try {
        const saved = localStorage.getItem('cnc_theme');
        if (saved) applyToRoot(JSON.parse(saved));
    } catch(_) {}
})();