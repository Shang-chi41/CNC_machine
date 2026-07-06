/**
 * js/auth.js
 * Quản lý JWT token, thông tin user, login/logout.
 *
 * Lưu trữ trong localStorage:
 *   cnc_token    — JWT access token
 *   cnc_username — Tên người dùng
 *   cnc_role     — Quyền: admin | operator | viewer
 *
 * Sử dụng:
 *   import { auth } from '/static/js/auth.js';
 *
 *   // Kiểm tra đăng nhập (gọi đầu mỗi page)
 *   auth.guard();
 *
 *   // Lấy thông tin user
 *   const name = auth.username();
 *   const role = auth.role();
 *
 *   // Đăng xuất
 *   auth.logout();
 *
 *   // Render user badge vào DOM
 *   auth.renderBadge('#userBadge');
 */

import { api, ApiError } from '/static/js/api.js';

// ── Storage keys ──────────────────────────────────────────────────────────
const KEY_TOKEN    = 'cnc_token';
const KEY_USERNAME = 'cnc_username';
const KEY_ROLE     = 'cnc_role';

// ── Auth object ───────────────────────────────────────────────────────────
export const auth = {

    // ── Getters ───────────────────────────────────────────────────────────

    /** Trả về JWT token hiện tại hoặc null */
    token()    { return localStorage.getItem(KEY_TOKEN);    },

    /** Trả về username hiện tại hoặc 'Guest' */
    username() { return localStorage.getItem(KEY_USERNAME) || 'Guest'; },

    /** Trả về role hiện tại hoặc 'viewer' */
    role()     { return localStorage.getItem(KEY_ROLE)     || 'viewer'; },

    /** Kiểm tra đã đăng nhập chưa */
    isLoggedIn() { return !!localStorage.getItem(KEY_TOKEN); },

    /** Kiểm tra có quyền operator trở lên không */
    isOperator() {
        const r = this.role();
        return r === 'admin' || r === 'operator';
    },

    /** Kiểm tra có quyền admin không */
    isAdmin() { return this.role() === 'admin'; },

    // ── Save / Clear ──────────────────────────────────────────────────────

    /**
     * Lưu thông tin đăng nhập sau khi login thành công.
     * @param {{ access_token, username, role }} data - Response từ /api/auth/login
     */
    save(data) {
        localStorage.setItem(KEY_TOKEN,    data.access_token);
        localStorage.setItem(KEY_USERNAME, data.username);
        localStorage.setItem(KEY_ROLE,     data.role);
    },

    /** Xóa toàn bộ thông tin đăng nhập */
    clear() {
        localStorage.removeItem(KEY_TOKEN);
        localStorage.removeItem(KEY_USERNAME);
        localStorage.removeItem(KEY_ROLE);
    },

    // ── Guard ─────────────────────────────────────────────────────────────

    /**
     * Kiểm tra đăng nhập — nếu chưa đăng nhập thì redirect /login.
     * Gọi đầu mỗi page (trừ login.html).
     *
     * @param {string} [redirectTo='/login'] - URL redirect nếu chưa login
     */
    guard(redirectTo = '/login') {
        if (!this.isLoggedIn()) {
            window.location.href = redirectTo;
            return false;
        }
        return true;
    },

    // ── Login ─────────────────────────────────────────────────────────────

    /**
     * Đăng nhập: gọi API + lưu token.
     * @param {string} username
     * @param {string} password
     * @returns {Promise<{ username, role }>}
     * @throws {ApiError} nếu sai thông tin
     */
    async login(username, password) {
        const data = await api.post('/api/auth/login', { username, password });
        this.save(data);
        return { username: data.username, role: data.role };
    },

    // ── Logout ────────────────────────────────────────────────────────────

    /**
     * Đăng xuất: gọi API + xóa token + redirect.
     * @param {string} [redirectTo='/login']
     */
    async logout(redirectTo = '/login') {
        try {
            await api.post('/api/auth/logout');
        } catch(_) {
            // Bỏ qua lỗi network khi logout — vẫn xóa token
        }
        this.clear();
        window.location.href = redirectTo;
    },

    // ── Change password ───────────────────────────────────────────────────

    /**
     * Đổi mật khẩu.
     * @param {string} oldPassword
     * @param {string} newPassword
     * @returns {Promise<{ status, message }>}
     */
    async changePassword(oldPassword, newPassword) {
        return api.post('/api/auth/change-password', {
            old_password: oldPassword,
            new_password: newPassword,
        });
    },

    // ── UI Helpers ────────────────────────────────────────────────────────

    /**
     * Render user badge vào element chỉ định.
     * Thay thế {{ username }} Jinja và form logout Flask.
     *
     * @param {string|HTMLElement} target - CSS selector hoặc element
     *
     * Render ra:
     *   <span class="user-dot"></span>
     *   <span>username</span>
     *   <button class="logout-btn">LOGOUT</button>
     */
    renderBadge(target = '.user-badge') {
        const el = typeof target === 'string'
            ? document.querySelector(target)
            : target;
        if (!el) return;

        el.innerHTML = `
            <span class="user-dot"></span>
            <span>${this.username()}</span>
            <span style="font-size:10px;color:var(--text-muted);padding:0 4px;">
                [${this.role()}]
            </span>
            <button class="logout-btn" id="logoutBtn">LOGOUT</button>
        `;

        el.querySelector('#logoutBtn').addEventListener('click', () => {
            if (confirm('Bạn có muốn đăng xuất không?')) {
                this.logout();
            }
        });
    },

    /**
     * Ẩn/disable các element cần quyền operator nếu user là viewer.
     * Thêm attribute data-require="operator" hoặc data-require="admin"
     * vào element HTML để tự động ẩn.
     */
    applyPermissions() {
        const role = this.role();

        document.querySelectorAll('[data-require]').forEach(el => {
            const required = el.getAttribute('data-require');
            let hasPermission = false;

            if (required === 'operator') hasPermission = this.isOperator();
            else if (required === 'admin') hasPermission = this.isAdmin();
            else hasPermission = this.isLoggedIn();

            if (!hasPermission) {
                el.style.display    = 'none';
                el.disabled         = true;
                el.style.pointerEvents = 'none';
            }
        });
    },

    /**
     * Khởi tạo auth cho page — gọi 1 lần trong DOMContentLoaded.
     * Tự động: guard + renderBadge + applyPermissions + highlight nav.
     *
     * @param {object} options
     * @param {boolean} [options.guard=true]      - Kiểm tra đăng nhập
     * @param {string}  [options.badge='.user-badge'] - Selector badge
     * @param {boolean} [options.permissions=true] - Áp dụng permission
     */
    init({ guard = true, badge = '.user-badge', permissions = true } = {}) {
        if (guard && !this.guard()) return false;
        if (badge)       this.renderBadge(badge);
        if (permissions) this.applyPermissions();
        _highlightNavbar();
        return true;
    },
};

// ── Private helpers ───────────────────────────────────────────────────────

/** Highlight nav-link active theo pathname hiện tại */
function _highlightNavbar() {
    const path = window.location.pathname;
    document.querySelectorAll('.nav-link').forEach(a => {
        a.classList.remove('active');
        const href = a.getAttribute('href');
        if (!href) return;
        const isHome    = href === '/' && path === '/';
        const isSubpage = href !== '/' && path.startsWith(href);
        if (isHome || isSubpage) a.classList.add('active');
    });
}