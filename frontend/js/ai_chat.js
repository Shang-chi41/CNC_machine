/**
 * js/ai_chat.js
 * Component AI Chat dung chung giua base.html (home), control.html, monitor.html,
 * settings.html va history.html (AI Panel ben phai HMI).
 *
 * Component nay quan ly:
 *   - Badge provider + tier (#aiProvBadge, #aiTierLbl hoac #aiTier)
 *   - Gui/nhan tin nhan AI Chat (poll /api/ai/chat/{id} cho toi khi done)
 *   - (tuy chon) Upload anh phoi truoc khi chat
 *   - (tuy chon) Luu G-Code AI sinh ra + gui sang Toolpath Preview (#toolpathFrame)
 *   - Sidebar status (Edge online / so luong alarm) — #sEdgeDot/#sEdgeTxt, #sAlmDot/#sAlmTxt
 *   - User bar (#aiUser, #aiRoleLbl) + nut Logout (window.doLogout)
 *
 * Su dung (trong moi trang):
 *   import { auth }      from '/static/js/auth.js';
 *   import { api }       from '/static/js/api.js';
 *   import { initAiChat, initSidebarStatus, initUserBar } from '/static/js/ai_chat.js';
 *
 *   initUserBar(auth);
 *   initSidebarStatus();
 *   initAiChat({ enableUpload:true, enableGcodeActions:true, onAfterChat: fetchGcodeList });
 */

import { api } from '/static/js/api.js';
import { DigitalTwinViewer } from '/static/js/digital_twin.js';

// ── User bar (ten + role tren AI panel) ─────────────────────────────────────
export function initUserBar(auth) {
    const u = document.getElementById('aiUser');
    if (u) u.textContent = auth.username();
    const r = document.getElementById('aiRoleLbl');
    if (r) r.textContent = `[${auth.role()}]`;
}

/** Gan window.doLogout dung chung cho moi trang (nut LOGOUT trong AI panel). */
export function initLogout(auth) {
    window.doLogout = async () => {
        if (confirm('Đăng xuất?')) await auth.logout();
    };
}

// ── Sidebar status (Edge online + so alarm) ─────────────────────────────────
export function initSidebarStatus(intervalMs = 15000) {
    async function fetchStatus() {
        try {
            const d = await api.get('/api/monitor/status');
            const online = d.sensor?.online;
            const n = d.alarms?.unresolved || 0;
            const c = d.alarms?.critical || 0;

            const sE = document.getElementById('sEdgeDot');
            const sT = document.getElementById('sEdgeTxt');
            if (sE) { sE.className = 'sdot ' + (online ? 'on' : 'off'); sT.textContent = online ? 'Edge OK' : 'Offline'; }

            const sA = document.getElementById('sAlmDot');
            const sAt = document.getElementById('sAlmTxt');
            if (sA) {
                sA.className = 'sdot ' + (c > 0 ? 'off' : n > 0 ? 'warn' : 'on');
                sAt.textContent = c > 0 ? `${c} critical` : n > 0 ? `${n} alarm` : 'No alarm';
            }
            return d;
        } catch (_) { return null; }
    }
    fetchStatus();
    setInterval(fetchStatus, intervalMs);
    return { fetchStatus };
}

// ── AI Provider badge ────────────────────────────────────────────────────────
export async function fetchProviderBadge() {
    try {
        const d = await api.get('/api/ai/provider/status');
        const badge = document.getElementById('aiProvBadge');
        if (badge) badge.textContent = `${d.provider || 'gemini'} ▾`;
        // base.html dung id "aiTier", cac trang con lai dung "aiTierLbl"
        const tier = document.getElementById('aiTierLbl') || document.getElementById('aiTier');
        if (tier) tier.textContent = `tier: ${d.tier || 'cloud'}`;
        return d;
    } catch (_) { return null; }
}

/**
 * Khoi tao AI Chat widget day du.
 *
 * @param {object} opts
 * @param {boolean} opts.enableUpload       - hien nut upload anh phoi (#aiFile phai co trong DOM)
 * @param {boolean} opts.enableGcodeActions - khi AI tra ve G-code: hien nut "Luu G-Code" + "Preview" (gui sang #toolpathFrame)
 * @param {Function} [opts.onAfterChat]     - callback chay sau khi 1 luot chat hoan tat (vd: refresh danh sach G-code)
 * @param {number} [opts.pollIntervalMs]    - chu ky poll ket qua AI (mac dinh 2000ms)
 * @param {number} [opts.maxPollTries]      - so lan poll toi da truoc khi bo cuoc (mac dinh 40)
 */
export function initAiChat(opts = {}) {
    const {
        enableUpload = false,
        enableGcodeActions = false,
        onAfterChat = null,
        pollIntervalMs = 2000,
        maxPollTries = 40,
    } = opts;

    let _busy = false;
    let _imgId = '';

    const _el = id => document.getElementById(id);

    function _appendMsg(role, html) {
        const c = _el('aiMsgs');
        if (!c) return null;
        const d = document.createElement('div');
        d.className = `ai-msg ${role}`;
        if (typeof html === 'string' && html.includes('<')) d.innerHTML = html;
        else d.textContent = html;
        c.appendChild(d);
        c.scrollTop = c.scrollHeight;
        return d;
    }

    function _typing() {
        const d = _appendMsg('ai', '<span class="typing-dots"><span>●</span><span>●</span><span>●</span></span>');
        if (d) d.id = '_typing';
        return d;
    }

    function _rmTyping() { _el('_typing')?.remove(); }

    function _buildGcodeReply(cleanText, gcode) {
        const gcEnc = encodeURIComponent(gcode || '');
        if (!enableGcodeActions) {
            return `${cleanText}<pre>${gcode || ''}</pre>`;
        }
        return `${cleanText}<pre>${gcode || ''}</pre>
            <div style="display:flex;gap:5px;margin-top:5px;">
                <button onclick="aiSaveGCode(this,'${gcEnc}')" style="font-size:9px;padding:2px 8px;border:1px solid var(--cyan-portal);background:transparent;color:var(--cyan-portal);border-radius:3px;cursor:pointer;">💾 Lưu G-Code</button>
                <button onclick="aiSendToViewer(this,'${gcEnc}')" style="font-size:9px;padding:2px 8px;border:1px solid var(--status-active);background:transparent;color:var(--status-active);border-radius:3px;cursor:pointer;">👁 Preview</button>
            </div>`;
    }

    async function sendChat() {
        if (_busy) return;
        const inp = _el('aiIn');
        const btn = _el('aiBtn');
        if (!inp) return;
        const msg = inp.value.trim();
        if (!msg) return;

        _busy = true;
        if (btn) btn.disabled = true;
        inp.value = '';
        _appendMsg('user', msg);
        _typing();

        try {
            const body = { message: msg };
            if (_imgId) { body.image_id = _imgId; _imgId = ''; }
            const r = await api.post('/api/ai/chat', body);
            const id = r?.conversation_id;
            if (!id) throw new Error('Không nhận được ID');

            let tries = 0;
            const iv = setInterval(async () => {
                tries++;
                try {
                    const d = await api.get(`/api/ai/chat/${id}`);
                    if (d.done || d.failed || tries > maxPollTries) {
                        clearInterval(iv);
                        _rmTyping();
                        const last = d.messages?.filter(m => m.role === 'assistant').pop();
                        const txt = last?.message || (d.failed ? '❌ AI thất bại' : '...');
                        if (last?.has_gcode) {
                            const clean = txt.replace(/```gcode[\s\S]*?```/g, '');
                            _appendMsg('ai', _buildGcodeReply(clean, last.gcode));
                        } else {
                            _appendMsg('ai', txt);
                        }
                        _busy = false;
                        if (btn) btn.disabled = false;
                        if (typeof onAfterChat === 'function') onAfterChat();
                    }
                } catch (_e) {
                    clearInterval(iv); _rmTyping(); _appendMsg('ai', '❌ Lỗi nhận phản hồi');
                    _busy = false; if (btn) btn.disabled = false;
                }
            }, pollIntervalMs);
        } catch (e) {
            _rmTyping(); _appendMsg('ai', `❌ ${e.message}`);
            _busy = false; if (btn) btn.disabled = false;
        }
    }

    window.aiSend = sendChat;
    window.aiKeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };
    window.aiRefreshProvider = fetchProviderBadge;

    if (enableUpload) {
        window.aiUpload = async function (ev) {
            const f = ev.target.files[0];
            if (!f) return;
            try {
                _appendMsg('sys', `📎 Đang upload ${f.name}...`);
                const fd = new FormData();
                fd.append('file', f);
                fd.append('description', 'Ảnh phôi HMI');
                const r = await api.upload('/api/ai/upload/image', fd);
                _imgId = r.image_id;
                _appendMsg('sys', `✅ Ảnh ready (${r.size_kb}KB). Nhập câu hỏi để AI phân tích.`);
            } catch (e) {
                _appendMsg('sys', `❌ Upload lỗi: ${e.message}`);
            }
            ev.target.value = '';
        };
    }

    if (enableGcodeActions) {
        window.aiSaveGCode = async function (btn, gcEnc) {
            const gc = decodeURIComponent(gcEnc || btn.getAttribute('data-g') || '');
            if (!gc) return;
            try {
                btn.textContent = '⏳...';
                const r = await api.post('/api/gcode/save', { content: gc, source: 'ai' });
                btn.textContent = `✅ ${r.gcode_id?.slice(-6)}`;
                btn.style.color = 'var(--status-active)';
                btn.style.borderColor = 'var(--status-active)';
                if (typeof onAfterChat === 'function') onAfterChat();
            } catch (e) { btn.textContent = '❌ Lỗi lưu'; }
        };

        window.aiSendToViewer = function (btn, gcEnc) {
            const gc = decodeURIComponent(gcEnc);
            // Khong tu tao twin moi moi lan goi — dung chung 1 instance tro toi
            // #toolpathFrame (chi co o control.html). Trang khac khong co frame
            // nay nen DigitalTwinViewer se chi la no-op (postMessage tren iframe null).
            const twin = new DigitalTwinViewer('toolpathFrame');
            twin.renderToolpath(gc);
            const status = _el('toolpathStatus');
            if (status) status.textContent = 'Đang preview...';
            if (btn) btn.textContent = '✅ Sent';
        };
    }

    fetchProviderBadge();

    return { sendChat, fetchProviderBadge };
}