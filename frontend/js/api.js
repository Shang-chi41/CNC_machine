/**
 * js/api.js
 * Fetch wrapper dùng chung cho toàn bộ frontend.
 *
 * - Tự động gắn Authorization: Bearer <token> vào mọi request
 * - Tự động redirect /login khi nhận 401
 * - Trả về data trực tiếp (không cần .json() ở từng chỗ)
 * - Xử lý lỗi network + server tập trung
 *
 * Sử dụng:
 *   import { api } from '/static/js/api.js';
 *   const data = await api.get('/api/monitor/sensor/latest');
 *   const res  = await api.post('/api/ai/chat', { message: 'hello' });
 */

// ── Config ────────────────────────────────────────────────────────────────
const CLOUD_API = window.CLOUD_API || '';   // prefix nếu Cloud khác origin

// ── Core fetch ────────────────────────────────────────────────────────────

/**
 * Gửi HTTP request với JWT header tự động.
 *
 * @param {string} endpoint   - Path từ /api/... (hoặc URL đầy đủ)
 * @param {object} options    - Fetch options (method, body, headers...)
 * @returns {Promise<any>}    - Parsed JSON hoặc null nếu response rỗng
 * @throws {ApiError}         - Khi server trả lỗi (4xx/5xx)
 */
async function request(endpoint, options = {}) {
    const token = localStorage.getItem('cnc_token');

    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(options.headers || {}),
    };

    // Nếu body là FormData thì bỏ Content-Type (browser tự set boundary)
    if (options.body instanceof FormData) {
        delete headers['Content-Type'];
    }

    const url = endpoint.startsWith('http') ? endpoint : `${CLOUD_API}${endpoint}`;

    let response;
    try {
        response = await fetch(url, { ...options, headers });
    } catch (networkErr) {
        throw new ApiError(0, `Lỗi mạng: ${networkErr.message}`, endpoint);
    }

    // 401 → hết hạn token → về login
    if (response.status === 401) {
        localStorage.removeItem('cnc_token');
        localStorage.removeItem('cnc_username');
        localStorage.removeItem('cnc_role');
        window.location.href = '/login';
        return null;
    }

    // Parse response
    const contentType = response.headers.get('content-type') || '';
    let data = null;

    if (contentType.includes('application/json')) {
        data = await response.json();
    } else if (contentType.includes('text/')) {
        data = await response.text();
    }
    // binary (download) → caller tự xử lý response object

    if (!response.ok) {
        const detail = (data && (data.detail || data.message || data.error))
            || `HTTP ${response.status}`;
        throw new ApiError(response.status, detail, endpoint);
    }

    return data;
}

// ── ApiError class ────────────────────────────────────────────────────────

export class ApiError extends Error {
    /**
     * @param {number} status   - HTTP status code
     * @param {string} message  - Error message
     * @param {string} endpoint - Endpoint gây ra lỗi
     */
    constructor(status, message, endpoint = '') {
        super(message);
        this.name    = 'ApiError';
        this.status  = status;
        this.endpoint = endpoint;
    }
}

// ── Public API object ─────────────────────────────────────────────────────

export const api = {

    /**
     * GET request.
     * @param {string} endpoint
     * @param {object} params   - Query params object { key: value }
     */
    get(endpoint, params = {}) {
        const qs = Object.keys(params).length
            ? '?' + new URLSearchParams(params).toString()
            : '';
        return request(`${endpoint}${qs}`, { method: 'GET' });
    },

    /**
     * POST request với JSON body.
     * @param {string} endpoint
     * @param {object} body
     */
    post(endpoint, body = {}) {
        return request(endpoint, {
            method: 'POST',
            body:   JSON.stringify(body),
        });
    },

    /**
     * PUT request với JSON body.
     */
    put(endpoint, body = {}) {
        return request(endpoint, {
            method: 'PUT',
            body:   JSON.stringify(body),
        });
    },

    /**
     * DELETE request.
     */
    delete(endpoint) {
        return request(endpoint, { method: 'DELETE' });
    },

    /**
     * Upload file (multipart/form-data).
     * @param {string}   endpoint
     * @param {FormData} formData
     */
    upload(endpoint, formData) {
        return request(endpoint, {
            method: 'POST',
            body:   formData,
            // Content-Type bị xóa trong request() khi body là FormData
        });
    },

    /**
     * Download file — trả về raw Response để caller gọi .blob()
     * @param {string} endpoint
     * @returns {Promise<Response>}
     */
    async download(endpoint) {
        const token = localStorage.getItem('cnc_token');
        const url   = endpoint.startsWith('http') ? endpoint : `${CLOUD_API}${endpoint}`;
        const res   = await fetch(url, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        if (res.status === 401) {
            window.location.href = '/login';
            return null;
        }
        if (!res.ok) throw new ApiError(res.status, `Download lỗi ${res.status}`, endpoint);
        return res;
    },

    /**
     * Poll một endpoint cho đến khi condition(data) trả true.
     * @param {string}   endpoint
     * @param {function} condition   - (data) => boolean
     * @param {number}   intervalMs  - Khoảng cách poll (ms), mặc định 2000
     * @param {number}   maxAttempts - Số lần tối đa, mặc định 40
     * @returns {Promise<any>}       - Data lần cuối khi condition thỏa
     * @throws {ApiError}            - Khi hết số lần thử
     */
    poll(endpoint, condition, intervalMs = 2000, maxAttempts = 40) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const iv = setInterval(async () => {
                attempts++;
                try {
                    const data = await api.get(endpoint);
                    if (condition(data)) {
                        clearInterval(iv);
                        resolve(data);
                    } else if (attempts >= maxAttempts) {
                        clearInterval(iv);
                        reject(new ApiError(408, 'Poll timeout', endpoint));
                    }
                } catch (err) {
                    clearInterval(iv);
                    reject(err);
                }
            }, intervalMs);
        });
    },
};

// Browser code must never know or send SYNC_API_KEY. Edge-only sync uses
// server-side .env through SyncWorker/CommandWorker. Kept as a no-op to avoid
// breaking old imports.
export function getSyncHeaders() {
    return {};
}

// ── Global error display helper ───────────────────────────────────────────

/**
 * Hiển thị lỗi API ra UI (tìm element #apiError hoặc console).
 * @param {ApiError|Error} err
 * @param {string}         containerId - ID element để hiển thị lỗi
 */
export function showApiError(err, containerId = 'apiError') {
    const el = document.getElementById(containerId);
    const msg = err instanceof ApiError
        ? `❌ [${err.status}] ${err.message}`
        : `❌ ${err.message}`;

    if (el) {
        el.textContent = msg;
        el.style.display = 'block';
        setTimeout(() => { el.style.display = 'none'; }, 5000);
    } else {
        console.error('[API Error]', msg);
    }
}