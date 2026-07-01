/**
 * js/digital_twin.js
 * Lop trung gian dung chung giua cac trang HMI (monitor.js, control.js, ...)
 * va iframe frontend/pages/cnc_viewer.html (3D viewer dung Three.js + OCCT).
 */

export class DigitalTwinViewer {
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

        this._boundHandler = this._handleMessage.bind(this);
        window.addEventListener('message', this._boundHandler);

        if (this.iframe && this.iframe.contentWindow) {
            this._post({ type: 'ping' });
        }

        this._timeoutId = setTimeout(() => {
            if (!this._ready && !this._isDestroyed) {
                console.warn('[DigitalTwinViewer] Timeout waiting for viewer_ready');
                this._ready = true;
                this._flushQueue();
            }
        }, timeoutMs);
    }

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

    _post(payload) {
        if (this._isDestroyed) return;

        if (!this._ready) {
            this._messageQueue.push(payload);
            return;
        }

        if (this.iframe?.contentWindow) {
            this.iframe.contentWindow.postMessage(payload, '*');
        }
    }

    _flushQueue() {
        if (this._isDestroyed) return;
        while (this._messageQueue.length > 0) {
            const msg = this._messageQueue.shift();
            this._post(msg);
        }
    }

    onReady(callback) {
        if (this._isDestroyed) return;
        if (this._ready) {
            callback();
        } else {
            this._readyCallbacks.push(callback);
        }
    }

    onToolpathRendered(callback) {
        if (this._isDestroyed) return;
        this._toolpathCallbacks.push(callback);
    }

    updateLoad(loadPercent) {
        this._post({ type: 'update_load', load: Math.min(Math.max(loadPercent || 0, 0), 150) });
    }

    renderToolpath(gcodeText) {
        if (!gcodeText || gcodeText.length < 10) return;
        this._post({ type: 'render_toolpath', gcode: gcodeText });
    }

    clearToolpath() {
        this._post({ type: 'clear_toolpath' });
    }

    reset() { this._post({ type: 'cnc_control', action: 'reset' }); }
    toggleWireframe() { this._post({ type: 'cnc_control', action: 'wire' }); }
    toggleGrid() { this._post({ type: 'cnc_control', action: 'grid' }); }
    toggleAxes() { this._post({ type: 'cnc_control', action: 'axes' }); }

    isReady() {
        return this._ready;
    }

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
