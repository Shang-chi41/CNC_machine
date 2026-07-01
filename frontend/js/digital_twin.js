/**
 * js/digital_twin.js
 * Lop trung gian dung chung giua cac trang HMI (monitor.js, control.js, ...)
 * va iframe frontend/pages/cnc_viewer.html (3D viewer dung Three.js + OCCT).
 *
 * Khong sua gi ben trong cnc_viewer.html — giao thuc postMessage giu nguyen:
 *   ra ngoai (gui sang iframe):
 *     { type: 'update_load',     load: number }            -> to mau model theo % tai
 *     { type: 'render_toolpath', gcode: string }            -> ve duong chay dao
 *     { type: 'clear_toolpath' }                            -> xoa duong chay dao
 *     { type: 'cnc_control',     action: 'reset'|'wire'|'grid'|'axes' }
 *   vao trong (nhan tu iframe):
 *     { type: 'viewer_ready' }
 *     { type: 'toolpath_rendered', points: number }
 *
 * monitor.js chi can update_load (mo hinh tinh, khong toolpath).
 * control.js can ca update_load lan render_toolpath/clear_toolpath.
 * Hai trang dung 2 instance DOC LAP cua class nay tren 2 iframe khac nhau
 * (#cncFrame o monitor.html, #toolpathFrame o control.html) — khong chia
 * se state, dung de tranh lap code postMessage o tung file.
 */

export class DigitalTwinViewer {
    /**
     * @param {string|HTMLIFrameElement} target - id cua iframe hoac chinh element iframe
     */
    constructor(target) {
        this.iframe = typeof target === 'string'
            ? document.getElementById(target)
            : target;

        this._ready = false;
        this._readyCallbacks = [];
        this._toolpathCallbacks = [];

        window.addEventListener('message', (ev) => {
            if (!ev.data || ev.source !== this.iframe?.contentWindow) return;
            if (ev.data.type === 'viewer_ready') {
                this._ready = true;
                this._readyCallbacks.forEach((cb) => cb());
                this._readyCallbacks = [];
            }
            if (ev.data.type === 'toolpath_rendered') {
                this._toolpathCallbacks.forEach((cb) => cb(ev.data.points));
            }
        });
    }

    _post(payload) {
        this.iframe?.contentWindow?.postMessage(payload, '*');
    }

    /** Goi callback khi iframe bao da load xong (viewer_ready). */
    onReady(callback) {
        if (this._ready) callback();
        else this._readyCallbacks.push(callback);
    }

    /** Goi callback moi lan toolpath duoc ve xong, nhan so diem da ve. */
    onToolpathRendered(callback) {
        this._toolpathCallbacks.push(callback);
    }

    /** To mau model theo % tai (0-100+). Dung cho ca monitor & control. */
    updateLoad(loadPercent) {
        this._post({ type: 'update_load', load: loadPercent });
    }

    /** Ve duong chay dao tu noi dung G-code (text). Chi dung cho control.html. */
    renderToolpath(gcodeText) {
        this._post({ type: 'render_toolpath', gcode: gcodeText });
    }

    /** Xoa duong chay dao dang ve. */
    clearToolpath() {
        this._post({ type: 'clear_toolpath' });
    }

    /** Cac thao tac dieu khien viewer: reset goc nhin, bat/tat wireframe, grid, axes. */
    reset() { this._post({ type: 'cnc_control', action: 'reset' }); }
    toggleWireframe() { this._post({ type: 'cnc_control', action: 'wire' }); }
    toggleGrid() { this._post({ type: 'cnc_control', action: 'grid' }); }
    toggleAxes() { this._post({ type: 'cnc_control', action: 'axes' }); }
}