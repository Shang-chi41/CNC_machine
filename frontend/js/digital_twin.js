/**
 * js/digital_twin.js
 * Lớp trung gian dùng chung giữa các trang HMI (monitor.js, control.js, ...)
 * và iframe frontend/pages/cnc_viewer.html (3D viewer dùng Three.js + OCCT).
 * 
 * Giao thức postMessage:
 *   Gửi sang iframe:
 *     { type: 'update_load',     load: number }      -> đổi màu model theo % tải
 *     { type: 'render_toolpath', gcode: string }     -> vẽ đường chạy dao
 *     { type: 'clear_toolpath' }                     -> xóa đường chạy dao
 *     { type: 'cnc_control',     action: string }    -> reset|wire|grid|axes
 *   
 *   Nhận từ iframe:
 *     { type: 'viewer_ready' }                       -> iframe đã sẵn sàng
 *     { type: 'toolpath_rendered', points: number }  -> đã vẽ xong toolpath
 */

export class DigitalTwinViewer {
    /**
     * @param {string|HTMLIFrameElement} target - id của iframe hoặc chính element iframe
     * @param {number} [timeoutMs=10000] - Thời gian chờ iframe ready (ms)
     */
    constructor(target, timeoutMs = 10000) {
        this.iframe = typeof target === 'string'
            ? document.getElementById(target)
            : target;

        this._ready = false;
        this._readyCallbacks = [];
        this._toolpathCallbacks = [];
        this._messageQueue = [];
        this._isDestroyed = false;
        this._timeoutId = null;

        // Lắng nghe message từ iframe
        this._boundHandler = this._handleMessage.bind(this);
        window.addEventListener('message', this._boundHandler);

        // Nếu iframe đã load trước khi constructor chạy, kiểm tra
        if (this.iframe && this.iframe.contentWindow) {
            // Gửi ping để kiểm tra
            this._post({ type: 'ping' });
        }

        // Timeout nếu iframe không bao giờ ready
        this._timeoutId = setTimeout(() => {
            if (!this._ready && !this._isDestroyed) {
                console.warn('[DigitalTwinViewer] Timeout waiting for viewer_ready');
                // Vẫn cho phép gửi message (có thể iframe đã ready nhưng không gửi event)
                this._ready = true;
                this._flushQueue();
            }
        }, timeoutMs);
    }

    /**
     * Xử lý message từ iframe
     */
    _handleMessage(ev) {
        if (this._isDestroyed) return;
        if (!ev.data || ev.source !== this.iframe?.contentWindow) return;

        switch (ev.data.type) {
            case 'viewer_ready':
                if (this._timeoutId) {
                    clearTimeout(this._timeoutId);
                    this._timeoutId = null;
                }
                this._ready = true;
                this._readyCallbacks.forEach(cb => cb());
                this._readyCallbacks = [];
                this._flushQueue();
                break;

            case 'toolpath_rendered':
                this._toolpathCallbacks.forEach(cb => cb(ev.data.points || 0));
                break;

            case 'pong':
                // Nếu nhận pong mà chưa ready, có thể iframe đã sẵn sàng
                if (!this._ready) {
                    this._ready = true;
                    if (this._timeoutId) {
                        clearTimeout(this._timeoutId);
                        this._timeoutId = null;
                    }
                    this._flushQueue();
                }
                break;
        }
    }

    /**
     * Gửi message sang iframe (có queue nếu chưa ready)
     */
    _post(payload) {
        if (this._isDestroyed) return;

        // Nếu chưa ready, queue lại
        if (!this._ready) {
            this._messageQueue.push(payload);
            return;
        }

        if (this.iframe?.contentWindow) {
            this.iframe.contentWindow.postMessage(payload, '*');
        } else {
            console.warn('[DigitalTwinViewer] iframe not available');
        }
    }

    /**
     * Gửi tất cả message đã queue
     */
    _flushQueue() {
        if (this._isDestroyed) return;
        while (this._messageQueue.length > 0) {
            const msg = this._messageQueue.shift();
            this._post(msg);
        }
    }

    /**
     * Đợi iframe ready, sau đó gọi callback
     * Nếu đã ready thì gọi ngay
     */
    onReady(callback) {
        if (this._isDestroyed) return;
        if (this._ready) {
            callback();
        } else {
            this._readyCallbacks.push(callback);
        }
    }

    /**
     * Đăng ký callback khi toolpath được vẽ xong
     * Callback nhận số điểm đã vẽ
     */
    onToolpathRendered(callback) {
        if (this._isDestroyed) return;
        this._toolpathCallbacks.push(callback);
    }

    /**
     * Gửi tải trọng để đổi màu model
     * @param {number} loadPercent - 0-100+
     */
    updateLoad(loadPercent) {
        this._post({ type: 'update_load', load: Math.min(Math.max(loadPercent || 0, 0), 150) });
    }

    /**
     * Vẽ đường chạy dao từ G-code
     * @param {string} gcodeText - Nội dung G-code
     */
    renderToolpath(gcodeText) {
        if (!gcodeText || gcodeText.length < 10) {
            console.warn('[DigitalTwinViewer] G-code quá ngắn, bỏ qua');
            return;
        }
        this._post({ type: 'render_toolpath', gcode: gcodeText });
    }

    /**
     * Xóa đường chạy dao
     */
    clearToolpath() {
        this._post({ type: 'clear_toolpath' });
    }

    /**
     * Điều khiển viewer
     */
    reset() { this._post({ type: 'cnc_control', action: 'reset' }); }
    toggleWireframe() { this._post({ type: 'cnc_control', action: 'wire' }); }
    toggleGrid() { this._post({ type: 'cnc_control', action: 'grid' }); }
    toggleAxes() { this._post({ type: 'cnc_control', action: 'axes' }); }

    /**
     * Kiểm tra iframe đã ready chưa
     */
    isReady() {
        return this._ready;
    }

    /**
     * Hủy instance, dọn dẹp
     */
    destroy() {
        this._isDestroyed = true;
        if (this._timeoutId) {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
        }
        window.removeEventListener('message', this._boundHandler);
        this._messageQueue = [];
        this._readyCallbacks = [];
        this._toolpathCallbacks = [];
        this.iframe = null;
    }
}
