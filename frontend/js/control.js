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

// =============================================
// 3D TOOLPATH VIEWER - Three.js
// =============================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ⭐ KHỞI TẠO THEME
theme.init();

// ⭐ HELPER FUNCTIONS
function _el(id) { return document.getElementById(id); }

function _normalizeGcodeText(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/\t/g, ' ').replace(/ +/g, ' ').trimEnd())
        .join('\n')
        .trim();
}

// ── G-CODE INTEGRITY — phát hiện sửa đổi sau khi approved ────────────────
let _gcodeIntegrity = {
    id:             null,   // _id của G-code đang hiển thị
    storedChecksum: null,   // SHA-256 checksum lưu từ server khi load
    isModified:     false,  // true nếu phát hiện nội dung đã thay đổi
};

/** Tính SHA-256 (hex) của một chuỗi bằng SubtleCrypto. */
async function _calcSHA256(text) {
    const buf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Gọi sau khi load G-code vào preview — khởi tạo checksum gốc. */
async function _initGcodeIntegrity(content) {
    _gcodeIntegrity.storedChecksum = await _calcSHA256(_normalizeGcodeText(content));
    _gcodeIntegrity.isModified     = false;
    _hideModifiedWarning();
}

/** Gọi 1 lần trong DOMContentLoaded — theo dõi mọi thay đổi trong gcodePreview. */
function _watchGcodePreview() {
    const preview = _el("gcodePreview");
    if (!preview) return;

    // 'input' event tốt hơn MutationObserver cho contenteditable
    preview.addEventListener('input', async () => {
        if (!_gcodeIntegrity.storedChecksum) return;

        const text = _normalizeGcodeText(preview.innerText || preview.textContent || "");

        // Sync currentGCode khi người dùng edit trực tiếp
        currentGCode = text;

        const current = await _calcSHA256(text);
        if (current !== _gcodeIntegrity.storedChecksum) {
            _gcodeIntegrity.isModified = true;
            preview.classList.add('is-modified');
            _showModifiedWarning();
            _disableConfirmRunButtons();
        } else {
            // Đã sửa lại về đúng nội dung gốc
            _gcodeIntegrity.isModified = false;
            preview.classList.remove('is-modified');
            _hideModifiedWarning();
            _enableConfirmRunButtons();
        }
    });

    // Paste event — strip HTML formatting, chỉ giữ plain text
    preview.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, text);
    });
}

function _showModifiedWarning() {
    const banner = _el("gcodeModifiedBanner");
    if (banner) banner.style.display = "flex";
}

function _hideModifiedWarning() {
    const banner = _el("gcodeModifiedBanner");
    if (banner) banner.style.display = "none";
}

function _disableConfirmRunButtons() {
    document.querySelectorAll(".gc-btn.conf, .gc-btn.run").forEach(btn => {
        btn.disabled = true;
        btn.title    = "G-code đã bị sửa — cần kiểm tra lại";
    });
}

function _enableConfirmRunButtons() {
    document.querySelectorAll(".gc-btn.conf, .gc-btn.run").forEach(btn => {
        btn.disabled = false;
        btn.title    = "";
    });
}

function _showCtrlMsg(msg, color) {
    const el = document.getElementById('ctrlMsg');
    if (el) {
        el.textContent = msg;
        el.style.color = color || 'var(--text-secondary)';
    }
}

// ⭐ BIẾN TOÀN CỤC
let currentGCode = '';
let _mode = 'manual';

// ⭐ 3D Toolpath Variables
const WS = { xMin: -200, xMax: 200, yMin: -150, yMax: 150, zMin: -50, zMax: 50 };
let tp3dRenderer = null, tp3dScene = null, tp3dCamera = null, tp3dOrbit = null;
let tp3dLine = null, tp3dHeadMesh = null, tp3dPoints = [];
let tp3dGridVisible = true, tp3dAxesVisible = true, tp3dBoxVisible = true, tp3dZPlaneVisible = true;
let tp3dSimInterval = null, tp3dSimIdx = 0, tp3dSimSpeed = 1.0;

// ⭐ DOMContentLoaded
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

    // ⭐ Khởi tạo 3D Toolpath
    setTimeout(initToolpath3D, 100);

    // ⭐ Speed slider — cập nhật cả fill lẫn giá trị
    const slider    = _el('simSpeedSlider');
    const speedVal  = _el('simSpeedValue');
    const speedFill = _el('simSpeedFill');
    if (slider) {
        slider.addEventListener('input', () => {
            tp3dSimSpeed = parseFloat(slider.value);
            if (speedVal)  speedVal.textContent  = tp3dSimSpeed.toFixed(1) + 'x';
            if (speedFill) {
                const pct = ((tp3dSimSpeed - 0.2) / (3 - 0.2)) * 100;
                speedFill.style.width = pct + '%';
            }
            if (tp3dSimInterval) { tp3dStop(); tp3dSimulate(); }
        });
    }

    if (window.location.hash === '#ai') setMode('auto');

    // ⭐ Khởi tạo theo dõi integrity G-code (phát hiện sửa đổi sau approved)
    _watchGcodePreview();
});

// ═══════════════════════════════════════════════════════════════════════════
// 3D TOOLPATH FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function initToolpath3D() {
    const canvas = document.getElementById('toolpath3D');
    if (!canvas) return;

    const parent = canvas.parentElement;
    const W = parent.clientWidth || 600;
    const H = parent.clientHeight || 480;

    const bgColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--gray-bg').trim() || '#C8CACF';

    tp3dRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    tp3dRenderer.setSize(W, H);
    tp3dRenderer.setClearColor(bgColor, 1);
    tp3dRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    tp3dScene = new THREE.Scene();
    tp3dScene.background = new THREE.Color(bgColor);

    tp3dCamera = new THREE.PerspectiveCamera(40, W/H, 1, 8000);
    tp3dCamera.position.set(300, 350, 450);

    tp3dOrbit = new OrbitControls(tp3dCamera, canvas);
    tp3dOrbit.enableDamping = true;
    tp3dOrbit.dampingFactor = 0.06;
    tp3dOrbit.target.set(0, 0, 0);

    // Lighting
    tp3dScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
    dirLight.position.set(200, 400, 300);
    tp3dScene.add(dirLight);

    buildAxes();
    animate3D();

    // Resize
    new ResizeObserver(() => {
        const p = canvas.parentElement;
        if (!p) return;
        const w = p.clientWidth, h = p.clientHeight;
        if (w > 0 && h > 0) {
            tp3dRenderer.setSize(w, h);
            tp3dCamera.aspect = w / h;
            tp3dCamera.updateProjectionMatrix();
        }
    }).observe(parent);
}

function animate3D() {
    requestAnimationFrame(animate3D);
    if (tp3dOrbit) tp3dOrbit.update();
    if (tp3dRenderer && tp3dScene && tp3dCamera) {
        tp3dRenderer.render(tp3dScene, tp3dCamera);
    }
}

function buildAxes() {
    if (!tp3dScene) return;

    // Xóa các đối tượng cũ
    const toRemove = [];
    tp3dScene.children.forEach(child => {
        if (child.userData?.isAxis) toRemove.push(child);
    });
    toRemove.forEach(child => {
        tp3dScene.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });

    const xMn = WS.xMin, xMx = WS.xMax, yMn = WS.yMin, yMx = WS.yMax, zMn = WS.zMin, zMx = WS.zMax;
    const WS_W = xMx - xMn, WS_D = yMx - yMn, WS_H = zMx - zMn;

    // Mảng nền mờ (đáy + vách sau) — giống bản gốc
    const panelMat = new THREE.MeshBasicMaterial({
        color: 0xD0D2D6, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false
    });

    const botP = new THREE.Mesh(new THREE.PlaneGeometry(WS_W, WS_D), panelMat.clone());
    botP.rotation.x = -Math.PI / 2;
    botP.position.set((xMn + xMx) / 2, zMn, -(yMn + yMx) / 2);
    botP.userData.isAxis = true;
    tp3dScene.add(botP);

    const backP = new THREE.Mesh(new THREE.PlaneGeometry(WS_W, WS_H), panelMat.clone());
    backP.position.set((xMn + xMx) / 2, (zMn + zMx) / 2, -yMx);
    backP.userData.isAxis = true;
    tp3dScene.add(backP);

    // Box — khung bao đúng workspace (không phải box đặt giữa tâm)
    if (tp3dBoxVisible) {
        const corners = [
            [xMn, zMn, -yMn], [xMx, zMn, -yMn], [xMx, zMx, -yMn], [xMn, zMx, -yMn],
            [xMn, zMn, -yMx], [xMx, zMn, -yMx], [xMx, zMx, -yMx], [xMn, zMx, -yMx]
        ];
        const boxEdges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        const boxPts = [];
        boxEdges.forEach(([a, b]) => { boxPts.push(new THREE.Vector3(...corners[a]), new THREE.Vector3(...corners[b])); });
        const boxGeo = new THREE.BufferGeometry().setFromPoints(boxPts);
        const box = new THREE.LineSegments(boxGeo, new THREE.LineBasicMaterial({ color: 0x9A9C9F, transparent: true, opacity: 0.7 }));
        box.userData.isAxis = true;
        tp3dScene.add(box);
    }

    // Lưới kẻ 3 mặt theo kích thước workspace
    if (tp3dGridVisible) {
        const gridMat = new THREE.LineBasicMaterial({ color: 0xB0B2B6, transparent: true, opacity: 0.6 });

        const gridPts = [];
        const yStep = WS_D / 6;
        for (let i = 0; i <= 6; i++) { const wy = -(yMn + i * yStep); gridPts.push(new THREE.Vector3(xMn, zMn, wy), new THREE.Vector3(xMx, zMn, wy)); }
        const xStep = WS_W / 8;
        for (let i = 0; i <= 8; i++) { const wx = xMn + i * xStep; gridPts.push(new THREE.Vector3(wx, zMn, -yMn), new THREE.Vector3(wx, zMn, -yMx)); }
        const gridLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPts), gridMat);
        gridLines.userData.isAxis = true;
        tp3dScene.add(gridLines);

        const backGridPts = [];
        const zStep = WS_H / 4;
        for (let i = 0; i <= 4; i++) { const wz = zMn + i * zStep; backGridPts.push(new THREE.Vector3(xMn, wz, -yMx), new THREE.Vector3(xMx, wz, -yMx)); }
        for (let i = 0; i <= 8; i++) { const wx = xMn + i * xStep; backGridPts.push(new THREE.Vector3(wx, zMn, -yMx), new THREE.Vector3(wx, zMx, -yMx)); }
        const backGridLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(backGridPts), gridMat.clone());
        backGridLines.userData.isAxis = true;
        tp3dScene.add(backGridLines);

        const lGridPts = [];
        for (let i = 0; i <= 4; i++) { const wz = zMn + i * zStep; lGridPts.push(new THREE.Vector3(xMn, wz, -yMn), new THREE.Vector3(xMn, wz, -yMx)); }
        for (let i = 0; i <= 6; i++) { const wy = -(yMn + i * yStep); lGridPts.push(new THREE.Vector3(xMn, zMn, wy), new THREE.Vector3(xMn, zMx, wy)); }
        const lGridLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lGridPts), gridMat.clone());
        lGridLines.userData.isAxis = true;
        tp3dScene.add(lGridLines);
    }

    // ⭐ AXES — mũi tên xuất phát từ góc workspace (giống bản gốc)
    if (tp3dAxesVisible) {
        const arrowX = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(xMn, zMn, -yMn), WS_W * 0.25, 0x1E5FA8, 8, 5);
        arrowX.userData.isAxis = true;
        tp3dScene.add(arrowX);

        const arrowY = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(xMn, zMn, -yMn), WS_D * 0.25, 0x1E5FA8, 8, 5);
        arrowY.userData.isAxis = true;
        tp3dScene.add(arrowY);

        const arrowZ = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(xMn, zMn, -yMn), WS_H * 0.6, 0x1E5FA8, 8, 5);
        arrowZ.userData.isAxis = true;
        tp3dScene.add(arrowZ);
    }

    // ⭐ Z-Plane (mặt phẳng Z=0)
    if (tp3dZPlaneVisible) {
        const planeGeo  = new THREE.PlaneGeometry(WS_W, WS_D);
        const planeMat  = new THREE.MeshBasicMaterial({
            color: 0x1E5FA8, transparent: true, opacity: 0.06,
            side: THREE.DoubleSide, depthWrite: false
        });
        const planeMesh = new THREE.Mesh(planeGeo, planeMat);
        planeMesh.rotation.x = -Math.PI / 2;
        planeMesh.position.set((xMn + xMx) / 2, 0, -(yMn + yMx) / 2);
        planeMesh.userData.isAxis = true;
        tp3dScene.add(planeMesh);
    }
}

function extractToolpath(gcode) {
    if (!gcode) return [];
    const pts = [];
    let x = 0, y = 0, z = 0;
    let abs = true;

    const lines = gcode.split(/\r?\n/);
    for (let line of lines) {
        line = line.split(';')[0].split('(')[0].trim();
        if (!line) continue;

        if (/^G90/i.test(line)) { abs = true;  continue; }
        if (/^G91/i.test(line)) { abs = false; continue; }

        const xM = line.match(/X([+-]?\d*\.?\d+)/i);
        const yM = line.match(/Y([+-]?\d*\.?\d+)/i);
        const zM = line.match(/Z([+-]?\d*\.?\d+)/i);

        if (xM) x = abs ? parseFloat(xM[1]) : x + parseFloat(xM[1]);
        if (yM) y = abs ? parseFloat(yM[1]) : y + parseFloat(yM[1]);
        if (zM) z = abs ? parseFloat(zM[1]) : z + parseFloat(zM[1]);

        if (xM || yM || zM) {
            pts.push({
                x: Math.max(WS.xMin, Math.min(WS.xMax, x)),
                y: Math.max(WS.yMin, Math.min(WS.yMax, y)),
                z: Math.max(WS.zMin, Math.min(WS.zMax, z))
            });
        }
    }
    return pts;
}

function buildToolpathLine(pts) {
    if (!tp3dScene) return;

    if (tp3dLine) {
        tp3dScene.remove(tp3dLine);
        if (tp3dLine.geometry) tp3dLine.geometry.dispose();
        tp3dLine = null;
    }
    if (tp3dHeadMesh) {
        tp3dScene.remove(tp3dHeadMesh);
        if (tp3dHeadMesh.geometry) tp3dHeadMesh.geometry.dispose();
        if (tp3dHeadMesh.material) tp3dHeadMesh.material.dispose();
        tp3dHeadMesh = null;
    }

    if (!pts.length) {
        showToolpathOverlay();
        return;
    }

    const positions = [];
    const colors    = [];

    pts.forEach((p, i) => {
        positions.push(p.x, p.z, -p.y);
        const t = pts.length > 1 ? i / (pts.length - 1) : 0;
        const r = 0x1E + (0xCC - 0x1E) * t;
        const g = 0x5F + (0x66 - 0x5F) * t;
        const b = 0xA8 + (0x00 - 0xA8) * t;
        colors.push(r/255, g/255, b/255);
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(colors),    3));

    tp3dLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    tp3dScene.add(tp3dLine);

    tp3dHeadMesh = new THREE.Mesh(
        new THREE.SphereGeometry(3.5, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xCC6600, emissive: 0xCC6600, emissiveIntensity: 0.3 })
    );
    tp3dHeadMesh.position.set(pts[0].x, pts[0].z, -pts[0].y);
    tp3dScene.add(tp3dHeadMesh);

    hideToolpathOverlay();

    // Update info
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), zs = pts.map(p => p.z);
    const infoEl = _el('tp3dInfo');
    if (infoEl) {
        infoEl.textContent = `${pts.length} điểm | X:${(Math.max(...xs)-Math.min(...xs)).toFixed(0)} Y:${(Math.max(...ys)-Math.min(...ys)).toFixed(0)} Z:${(Math.max(...zs)-Math.min(...zs)).toFixed(0)} mm`;
    }
}

function updateToolpath(gcode) {
    const pts = extractToolpath(gcode);
    tp3dPoints = pts;
    buildToolpathLine(pts);
}

function clearToolpath3D() {
    if (tp3dLine) {
        tp3dScene.remove(tp3dLine);
        if (tp3dLine.geometry) tp3dLine.geometry.dispose();
        tp3dLine = null;
    }
    if (tp3dHeadMesh) {
        tp3dScene.remove(tp3dHeadMesh);
        if (tp3dHeadMesh.geometry) tp3dHeadMesh.geometry.dispose();
        if (tp3dHeadMesh.material) tp3dHeadMesh.material.dispose();
        tp3dHeadMesh = null;
    }
    tp3dPoints = [];
    showToolpathOverlay();
    const infoEl = _el('tp3dInfo');
    if (infoEl) infoEl.textContent = 'Chưa có G-Code';
}

// ⭐ OVERLAY
function showToolpathOverlay() {
    const o = _el('tp3dOverlay');
    if (o) { o.classList.remove('hidden'); o.classList.add('visible'); }
}
function hideToolpathOverlay() {
    const o = _el('tp3dOverlay');
    if (o) { o.classList.remove('visible'); o.classList.add('hidden'); }
}

// ─── Toggle helpers ───────────────────────────────────────────────────────
function _rebuildAndReattach() {
    buildAxes();
    if (tp3dLine)     tp3dScene.add(tp3dLine);
    if (tp3dHeadMesh) tp3dScene.add(tp3dHeadMesh);
}

function tp3dToggleGrid() {
    tp3dGridVisible = !tp3dGridVisible;
    _rebuildAndReattach();
    const btn = _el('btnTpGrid');
    if (btn) btn.classList.toggle('active', tp3dGridVisible);
}

function tp3dToggleAxes() {
    tp3dAxesVisible = !tp3dAxesVisible;
    _rebuildAndReattach();
    const btn = _el('btnTpAxes');
    if (btn) btn.classList.toggle('active', tp3dAxesVisible);
}

function tp3dToggleBox() {
    tp3dBoxVisible = !tp3dBoxVisible;
    _rebuildAndReattach();
    const btn = _el('btnTpBox');
    if (btn) btn.classList.toggle('active', tp3dBoxVisible);
}

// ⭐ Z-PLANE toggle (mới thêm)
function tp3dToggleZPlane() {
    tp3dZPlaneVisible = !tp3dZPlaneVisible;
    _rebuildAndReattach();
    const btn = _el('btnTpZPlane');
    if (btn) btn.classList.toggle('active', tp3dZPlaneVisible);
}

// ⭐ RESET về view ban đầu (tên đúng như HTML gọi)
function tp3dReset() {
    _rebuildAndReattach();
    if (tp3dCamera) tp3dCamera.position.set(300, 350, 450);
    if (tp3dOrbit)  { tp3dOrbit.target.set(0, 0, 0); tp3dOrbit.update(); }
}

function tp3dSimulate() {
    if (!tp3dPoints.length) {
        _showCtrlMsg('⚠️ Chưa có G-Code để mô phỏng', 'var(--status-warning)');
        return;
    }
    if (tp3dSimInterval) clearInterval(tp3dSimInterval);
    tp3dSimIdx = 0;
    const total = tp3dPoints.length;
    const delay = Math.max(10, Math.min(100, 30 / tp3dSimSpeed));
    tp3dSimInterval = setInterval(() => {
        if (tp3dSimIdx >= total) {
            clearInterval(tp3dSimInterval);
            tp3dSimInterval = null;
            _showCtrlMsg('✅ Mô phỏng xong!', 'var(--status-active)');
            return;
        }
        const p = tp3dPoints[tp3dSimIdx];
        if (tp3dHeadMesh) tp3dHeadMesh.position.set(p.x, p.z, -p.y);
        _el('tp3dX').textContent = p.x.toFixed(1);
        _el('tp3dY').textContent = p.y.toFixed(1);
        _el('tp3dZ').textContent = p.z.toFixed(1);
        const pct = ((tp3dSimIdx + 1) / total * 100).toFixed(1);
        _el('tp3dProgress').textContent = pct + '%';
        _el('tp3dFill').style.width = pct + '%';
        tp3dSimIdx++;
    }, delay);
}

function tp3dStop() {
    clearInterval(tp3dSimInterval);
    tp3dSimInterval = null;
}

function tp3dResetSim() {
    tp3dStop();
    tp3dSimIdx = 0;
    ['tp3dX', 'tp3dY', 'tp3dZ'].forEach(id => { const el = _el(id); if (el) el.textContent = '0'; });
    const prog = _el('tp3dProgress'); if (prog) prog.textContent = '0%';
    const fill = _el('tp3dFill');     if (fill) fill.style.width = '0%';
    if (tp3dHeadMesh && tp3dPoints.length) {
        tp3dHeadMesh.position.set(tp3dPoints[0].x, tp3dPoints[0].z, -tp3dPoints[0].y);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLUIDNC CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

const KEY_FLUIDNC_LAST  = 'cnc_fluidnc_url';
const KEY_FLUIDNC_SAVED = 'cnc_fluidnc_saved_urls';
let _fluidncLoadTimer = null;

function _fluidncSavedUrls() {
    try { return JSON.parse(localStorage.getItem(KEY_FLUIDNC_SAVED) || '[]'); }
    catch { return []; }
}

function _fluidncRenderSaved() {
    const wrap = _el('savedUrlsList');
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
        _el('deviceUrl').value = last;
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
    const badge = _el('connectionStatus');
    const dot   = _el('manualStatusDot');
    const text  = _el('manualStatusText');
    const urlEl = _el('manualStatusUrl');
    const map   = {
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
    const frame   = _el('fluidncFrame');
    const empty   = _el('manualEmpty');
    const loading = _el('manualLoading');
    const error   = _el('manualError');
    if (_fluidncLoadTimer) clearTimeout(_fluidncLoadTimer);
    empty.style.display   = 'none';
    error.style.display   = 'none';
    loading.style.display = 'flex';
    frame.style.display   = 'none';
    _fluidncSetStatus('connecting', url);
    frame.src = url;

    _fluidncLoadTimer = setTimeout(() => {
        // Many browsers block LAN HTTP iframes from an HTTPS HMI without firing
        // iframe.onerror.  Treat a still-visible loading overlay as blocked and
        // show an explicit fallback instead of leaving a blank panel.
        if (loading.style.display !== 'none') {
            loading.style.display = 'none';
            frame.style.display = 'none';
            const msg = _el('manualErrMsg');
            if (msg) msg.textContent = 'Không tải được FluidNC trong iframe. Có thể bị CORS/mixed-content hoặc khác mạng LAN. Hãy mở TAB MỚI hoặc dùng lệnh Home/Jog qua HMI.';
            error.style.display = 'flex';
            _fluidncSetStatus('error', url);
        }
    }, 5000);
}

window.connectToDevice = function () {
    const input = _el('deviceUrl');
    const url   = _fluidncNormalize(input.value);
    if (!url) { _fluidncSetStatus('disconnected'); return; }
    localStorage.setItem(KEY_FLUIDNC_LAST, url);
    _fluidncSaveUrl(url);
    _fluidncLoad(url);
};

window.quickConnect = function (url) {
    _el('deviceUrl').value = url;
    localStorage.setItem(KEY_FLUIDNC_LAST, url);
    _fluidncSaveUrl(url);
    _fluidncLoad(url);
};

window.retryManual = function () {
    const last = localStorage.getItem(KEY_FLUIDNC_LAST);
    if (last) _fluidncLoad(last);
};

window.openConnectionInNewTab = function () {
    const url = localStorage.getItem(KEY_FLUIDNC_LAST) || _fluidncNormalize(_el('deviceUrl').value);
    if (url) window.open(url, '_blank');
};

window.closeConnection = function () {
    const frame = _el('fluidncFrame');
    frame.src = 'about:blank';
    frame.style.display = 'none';
    _el('manualLoading').style.display = 'none';
    _el('manualError').style.display   = 'none';
    _el('manualEmpty').style.display   = 'flex';
    localStorage.removeItem(KEY_FLUIDNC_LAST);
    _fluidncSetStatus('disconnected');
};

window.onManualFrameLoad = function () {
    if (_fluidncLoadTimer) clearTimeout(_fluidncLoadTimer);
    _el('manualLoading').style.display = 'none';
    _el('fluidncFrame').style.display  = 'block';
    const url = localStorage.getItem(KEY_FLUIDNC_LAST) || '';
    _fluidncSetStatus('connected', url);
};

window.onManualFrameError = function () {
    if (_fluidncLoadTimer) clearTimeout(_fluidncLoadTimer);
    _el('manualLoading').style.display = 'none';
    _el('fluidncFrame').style.display  = 'none';
    _el('manualErrMsg').textContent    =
        'Không thể tải giao diện FluidNC. Kiểm tra lại IP/URL và đảm bảo bạn đang cùng mạng LAN với máy CNC.';
    _el('manualError').style.display = 'flex';
    _fluidncSetStatus('error');
};

// ═══════════════════════════════════════════════════════════════════════════
// MODE TOGGLE
// ═══════════════════════════════════════════════════════════════════════════

window.setMode = function (mode) {
    _mode = mode;
    _el('modeManual').classList.toggle('active', mode === 'manual');
    _el('modeAuto').classList.toggle('active',   mode === 'auto');
    _el('btnManual').classList.toggle('active',  mode === 'manual');
    _el('btnAuto').classList.toggle('active',    mode === 'auto');
    if (mode === 'auto') fetchGcodeList();
};

// ═══════════════════════════════════════════════════════════════════════════
// MACHINE STATUS
// ═══════════════════════════════════════════════════════════════════════════

async function fetchMachineStatus() {
    try {
        const d     = await api.get('/api/control/status');
        const state = d.status   || '—';
        const pos   = d.position || {};
        const curA  = d.current_A || 0;

        const dot = _el('machDot');
        if (dot) dot.className = `ms-dot ${state === 'Run' ? 'on' : state === 'Alarm' ? 'off' : state === 'Hold' ? 'warn' : 'idle'}`;
        _el('machState').textContent = state;
        _el('machPos').textContent   = `X:${(pos.x || 0).toFixed(1)} Y:${(pos.y || 0).toFixed(1)} Z:${(pos.z || 0).toFixed(1)}`;

        _el('autoState').textContent = state;
        _el('autoX').textContent     = (pos.x || 0).toFixed(2);
        _el('autoY').textContent     = (pos.y || 0).toFixed(2);
        _el('autoZ').textContent     = (pos.z || 0).toFixed(2);
        _el('autoI').textContent     = curA.toFixed(2);
    } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// G-CODE LIST
// ═══════════════════════════════════════════════════════════════════════════

async function fetchGcodeList() {
    try {
        const data = await api.get('/api/gcode/history', { limit: 20 });
        _renderGcodeList(data);
    } catch (e) {
        _el('gcodeList').innerHTML = `<div class="gc-empty">❌ ${e.message}</div>`;
    }
}

function _renderGcodeList(data) {
    const el      = _el('gcodeList');
    const pending = data.filter(g => ['pending_validation','pending_confirmation','approved','confirmed','queued','executing'].includes(g.status));
    if (!pending.length) { el.innerHTML = '<div class="gc-empty">📭 Không có G-code đang chờ</div>'; return; }
    el.innerHTML = pending.map(g => {
        const isExecuting = g.status === 'executing';
        const isQueued = g.status === 'queued';
        const stClass = isExecuting ? 'gc-s-run' : isQueued ? 'gc-s-queue' : g.status === 'confirmed' ? 'gc-s-conf' : g.status === 'approved' ? 'gc-s-conf' : g.status === 'rejected' ? 'gc-s-rej' : 'gc-s-pend';
        const stLabel = isExecuting ? 'ĐANG CHẠY' : isQueued ? 'QUEUED' : g.status === 'confirmed' ? 'Confirmed' : g.status === 'approved' ? 'Approved' : g.status === 'rejected' ? 'Rejected' : 'Chờ';
        const canRun  = g.status === 'confirmed' || isQueued;
        const canConf = ['approved','pending_confirmation','pending_validation'].includes(g.status);
        const isRejected = g.status === 'rejected';
        const rejId = JSON.stringify({reason: g.rejection_reason || '', fix: g.suggested_fix || ''}).replace(/'/g, '&apos;');
        const actions = [
            canConf ? `<button class="gc-btn conf" onclick="confirmGcode('${g._id}',this)">✓ Confirm</button>` : '',
            canRun  ? `<button class="gc-btn run"  onclick="runGcode('${g._id}',this)">▶ Run</button>` : '',
            isRejected ? `<button class="gc-btn" style="color:var(--status-alarm);border-color:var(--status-alarm);" onclick="showRejectionReason('${g._id}')">⚠️ Xem lý do</button>` : '',
            `<button class="gc-btn" onclick="previewGcode('${g._id}')">👁</button>`,
        ].filter(Boolean).join('');
        return `<div class="gc-item ${isExecuting ? 'is-executing' : ''}">
            <span class="gc-name" title="${g.filename || ''}">${g.filename || g._id?.slice(-8) || '—'}</span>
            <span class="gc-status ${stClass}">${stLabel}</span>
            <div class="gc-actions">${actions}</div>
        </div>`;
    }).join('');
}

async function confirmGcode(id, btn) {
    btn.disabled = true; btn.textContent = '...';
    // Verify integrity trước khi confirm — block nếu G-code đã bị sửa
    if (_gcodeIntegrity.storedChecksum && currentGCode) {
        try {
            const check = await api.post(`/api/gcode/${id}/verify_checksum`, { content: currentGCode });
            if (!check.match) {
                btn.disabled = false; btn.textContent = '✓ Confirm';
                _showModifiedWarning();
                _disableConfirmRunButtons();
                _showCtrlMsg('⚠️ G-code đã bị sửa — cần kiểm tra lại trước khi confirm', 'var(--status-warning)');
                return;
            }
        } catch (_) { /* không có checksum cũ → bỏ qua, để backend xử lý */ }
    }
    try {
        await api.post(`/api/gcode/${id}/confirm`);
        _showCtrlMsg('✅ Đã confirm G-code', 'var(--status-active)');
        fetchGcodeList();
    } catch (e) {
        btn.disabled = false; btn.textContent = '✓ Confirm';
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
}

async function runGcode(id, btn) {
    if (!(await _isRunGateReadyForCommand())) {
        _showCtrlMsg('🔒 RUN bị khóa bởi Run Permission Gate', 'var(--status-warning)');
        return;
    }
    if (!confirm('Xác nhận chạy G-code này?')) return;
    btn.disabled = true; btn.textContent = '⏳...';
    try {
        const r = await api.post(`/api/control/run/${id}`);
        _showCtrlMsg('▶️ Đang chạy G-code...', 'var(--status-active)');
        hideCollisionBanner();
        fetchGcodeList();
        // Bắt đầu poll stream progress từ backend
        pollStreamProgress(tp3dPoints.length || 0);
    } catch (e) {
        btn.disabled = false; btn.textContent = '▶ Run';
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
}

// ─── TASK 2: Poll stream progress từ backend ───────────────────────────────
let _streamPollInterval = null;

function pollStreamProgress(totalLines) {
    if (_streamPollInterval) clearInterval(_streamPollInterval);

    _streamPollInterval = setInterval(async () => {
        try {
            const d = await api.get('/api/control/stream_progress');
            if (!d.is_streaming) {
                clearInterval(_streamPollInterval);
                _streamPollInterval = null;
                _showCtrlMsg('✅ Hoàn thành chạy G-code', 'var(--status-active)');
                const prog = _el('tp3dProgress'); if (prog) prog.textContent = '100%';
                const fill = _el('tp3dFill');     if (fill) fill.style.width = '100%';
                fetchGcodeList();
                return;
            }

            // Dùng total_lines từ backend nếu không có local
            const total = d.total_lines || totalLines || 1;
            const pct = (d.current_line / total * 100).toFixed(1);

            const progEl = _el('tp3dProgress'); if (progEl) progEl.textContent = pct + '%';
            const fillEl = _el('tp3dFill');     if (fillEl) fillEl.style.width = pct + '%';

            // Cập nhật vị trí head 3D theo dòng hiện tại
            if (tp3dPoints[d.current_line]) {
                const p = tp3dPoints[d.current_line];
                if (tp3dHeadMesh) tp3dHeadMesh.position.set(p.x, p.z, -p.y);
                _el('tp3dX').textContent = p.x.toFixed(1);
                _el('tp3dY').textContent = p.y.toFixed(1);
                _el('tp3dZ').textContent = p.z.toFixed(1);
            }

            // Kiểm tra collision/alarm từ machine status
            const status = await api.get('/api/control/status');
            if (status.status === 'Alarm') {
                clearInterval(_streamPollInterval);
                _streamPollInterval = null;
                showCollisionBanner(status.status || 'Alarm phát hiện');
                fetchGcodeList();
            }
        } catch (_) {}
    }, 1000);
}

// ─── TASK 3c+3d: Collision banner ──────────────────────────────────────────
function showCollisionBanner(reason) {
    const banner = _el('collisionBanner');
    if (!banner) return;
    banner.textContent = `🛑 VA CHẠM PHÁT HIỆN — E-STOP đã kích hoạt: ${reason}`;
    banner.classList.remove('hidden');
    banner.style.display = 'block';
}

function hideCollisionBanner() {
    const banner = _el('collisionBanner');
    if (!banner) return;
    banner.classList.add('hidden');
    banner.style.display = 'none';
}

window.hideCollisionBanner = hideCollisionBanner;

function previewGcode(id) {
    _el('toolpathStatus').textContent = `Đang load G-code ${id.slice(-6)}...`;
    fetch(`/api/gcode/${id}`)
        .then(r => r.json())
        .then(doc => {
            const content = doc?.gcode || '';
            if (!content) throw new Error('G-code rỗng');
            updateToolpath(content);
            _el('toolpathStatus').textContent = `✅ Đã vẽ toolpath ${id.slice(-6)}`;
        })
        .catch(e => { _el('toolpathStatus').textContent = `❌ ${e.message}`; });
}

// ─── TASK 3b: Rejection modal ──────────────────────────────────────────────
async function showRejectionReason(id) {
    try {
        const doc = await api.get(`/api/gcode/${id}`);
        const reason = doc.rejection_reason || doc.reject_reason || '(Không có thông tin)';
        const fix    = doc.suggested_fix || '';
        const modal  = _el('rejectionModal');
        const reasonEl = _el('rejectionReason');
        const fixEl    = _el('suggestedFix');
        if (reasonEl) reasonEl.textContent = reason;
        if (fixEl)    fixEl.textContent    = fix || '(Không có gợi ý)';
        if (modal)   { modal.classList.remove('hidden'); modal.style.display = 'flex'; }
    } catch (e) {
        _showCtrlMsg('❌ Không tải được lý do: ' + e.message, 'var(--status-alarm)');
    }
}

function closeRejectionModal() {
    const modal = _el('rejectionModal');
    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
}

window.fetchGcodeList      = fetchGcodeList;
window.confirmGcode        = confirmGcode;
window.runGcode            = runGcode;
window.previewGcode        = previewGcode;
window.showRejectionReason = showRejectionReason;
window.closeRejectionModal = closeRejectionModal;

// ── Nút "🔍 Kiểm tra lại" trên gcodeModifiedBanner ────────────────────────
window.revalidateModifiedGcode = async function () {
    if (!currentGCode || !currentGCode.trim()) return;
    _showCtrlMsg("🔍 Đang gửi G-code để kiểm tra lại...", "var(--status-warning)");
    try {
        await api.post("/api/gcode/save", {
            content:  currentGCode,
            source:   "ai",
            filename: `recheck_${Date.now()}.nc`,
        });
        _showCtrlMsg("✅ Đã gửi G-code mới vào queue — chờ AI validate", "var(--status-active)");
        fetchGcodeList();
    } catch (e) {
        _showCtrlMsg("❌ " + e.message, "var(--status-alarm)");
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// QUICK ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

window.sendCmd = async function (action) {
    _showCtrlMsg(`⚡ ${action}...`, 'var(--status-warning)');
    try {
        await api.post(`/api/control/${action}`);
        const msgs = { home: '🏠 Lệnh Home đã gửi', stop: '⏸ Feed Hold đã gửi', resume: '▶️ Resume đã gửi', unlock: '🔓 Unlock đã gửi' };
        _showCtrlMsg(msgs[action] || '✅ OK', 'var(--status-active)');
    } catch (e) {
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// ESTOP
// ═══════════════════════════════════════════════════════════════════════════

window.sendEstop = async function () {
    if (!confirm('⚠️ DỪNG KHẨN CẤP?\nMáy sẽ dừng ngay lập tức!')) return;
    const btn = _el('estopFab');
    btn.style.animation = 'pulse 0.3s infinite';
    try {
        await api.post('/api/control/estop');
        _showCtrlMsg('🛑 ESTOP đã gửi — Máy đang dừng', 'var(--status-alarm)');
    } catch (e) {
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
    btn.style.animation = '';
};

// ═══════════════════════════════════════════════════════════════════════════
// JOG
// ═══════════════════════════════════════════════════════════════════════════

window.jog = async function (axis, dir) {
    const dist = parseFloat(_el('jogDist').value) * dir;
    const feed = parseFloat(_el('jogFeed').value);
    if (!Number.isFinite(dist) || !Number.isFinite(feed)) {
        _showCtrlMsg('⚠️ Khoảng cách hoặc tốc độ Jog không hợp lệ', 'var(--status-warning)');
        return;
    }
    if (Math.abs(dist) > 10) {
        const ok = confirm(`Jog ${axis} ${dist > 0 ? '+' : ''}${dist}mm — xác nhận khoảng cách lớn?`);
        if (!ok) return;
    }
    try {
        await api.post('/api/control/jog', { axis, distance: dist, feed });
        _showCtrlMsg(`🎮 Jog ${axis}${dist > 0 ? '+' : ''}${dist}mm F${feed}`, 'var(--status-active)');
    } catch (e) {
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
};


async function _isRunGateReadyForCommand() {
    if (window.__hmiRunReady === true || document.body.dataset.runReady === 'true') return true;
    try {
        const d = await api.get('/api/pose/latest');
        const p = d.payload || d || {};
        return String(p.run_permission || p.run || '').toUpperCase() === 'READY';
    } catch (_) {
        return false;
    }
}

window.runAll = async function () {
    const ready = await _isRunGateReadyForCommand();
    if (!ready) {
        _showCtrlMsg('🔒 RUN đang bị khóa: cần Home Sync, CHECK, Approval và No Alarm', 'var(--status-warning)');
        return;
    }
    try {
        const list = await api.get('/api/gcode/history', { limit: 20 });
        const candidate = list.find(g => ['confirmed', 'queued'].includes(g.status));
        if (!candidate) {
            _showCtrlMsg('⚠️ Không có G-code confirmed/queued để chạy', 'var(--status-warning)');
            return;
        }
        if (!confirm(`Xác nhận chạy G-code: ${candidate.filename || candidate._id}?`)) return;
        await runGcode(candidate._id, _el('runAllBtn'));
    } catch (e) {
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
};

window.pauseAll = async function () {
    try {
        await api.post('/api/control/stop');
        _showCtrlMsg('⏸ Feed Hold đã gửi', 'var(--status-warning)');
    } catch (e) {
        _showCtrlMsg('❌ ' + e.message, 'var(--status-alarm)');
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// G-CODE FROM AI
// ═══════════════════════════════════════════════════════════════════════════

function setGCodeFromAI(gcode) {
    currentGCode = gcode;
    const preview = _el('gcodePreview');
    if (preview) preview.innerHTML = `<pre style="margin:0;white-space:pre-wrap;font-size:10px;">${gcode}</pre>`;
    const btn = _el('downloadBtn');
    if (btn) btn.disabled = false;
    updateToolpath(gcode);
    // Khởi tạo checksum gốc sau khi load G-code mới
    _initGcodeIntegrity(gcode);
}

function downloadGCode() {
    if (!currentGCode) { alert('Chưa có G-Code'); return; }
    const a = document.createElement('a');
    a.download = `cnc_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.nc`;
    a.href = URL.createObjectURL(new Blob([currentGCode], { type: 'text/plain' }));
    a.click();
}

function clearGCode() {
    currentGCode = '';
    const preview = _el('gcodePreview');
    if (preview) preview.innerHTML = '⏳ Chưa có G-Code';
    const btn = _el('downloadBtn');
    if (btn) btn.disabled = true;
    clearToolpath3D();
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

// ═══════════════════════════════════════════════════════════════════════════
// NẠP FILE G-CODE
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    const gcFileInput  = _el('gcFileInput');
    const gcUploadArea = _el('gcUploadArea');
    if (gcUploadArea) {
        gcUploadArea.addEventListener('dragover',  e => { e.preventDefault(); gcUploadArea.classList.add('dragover'); });
        gcUploadArea.addEventListener('dragleave', ()  => gcUploadArea.classList.remove('dragover'));
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
        const preview = _el('gcodePreview');
        if (preview) preview.innerHTML =
            `<pre style="margin:0;white-space:pre-wrap;font-size:10px;">${text.slice(0, 800)}${text.length > 800 ? '\n...(còn nữa)' : ''}</pre>`;
        const btn = _el('downloadBtn'); if (btn) btn.disabled = false;

        const gcFileName  = _el('gcFileName');
        const gcLineCount = _el('gcLineCount');
        const gcFileInfo  = _el('gcFileInfo');
        const askAiBtn    = _el('askAiBtn');
        if (gcFileName)  gcFileName.textContent  = `📄 ${file.name}`;
        if (gcLineCount) gcLineCount.textContent  = `${text.split('\n').length} dòng · ${(file.size / 1024).toFixed(1)} KB`;
        if (gcFileInfo)  gcFileInfo.style.display = 'block';
        if (askAiBtn)    askAiBtn.style.display   = 'block';

        updateToolpath(text);
        // Khởi tạo checksum gốc sau khi nạp file
        _initGcodeIntegrity(text);
        _showCtrlMsg(`✅ Đã nạp ${file.name}`, 'var(--status-active)');
    };
    r.readAsText(file);
}

function askAiAboutGCode() {
    if (!currentGCode) return;
    const input = _el('aiIn');
    if (input) { input.value = 'Hãy phân tích và tối ưu G-Code này cho tôi'; input.focus(); }
}


function initWorkpieceUploadFeedback() {
    const input = _el('fileInput');
    const area = _el('uploadArea');
    const info = _el('fileInfo');
    const nameEl = _el('fileName');
    const sizeEl = _el('fileSize');
    const preview = _el('previewImage');
    if (!input || !area) return;
    input.addEventListener('change', (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        area.classList.add('is-loading');
        area.textContent = '⏳ Đang đọc file...';
        if (nameEl) nameEl.textContent = file.name;
        if (sizeEl) sizeEl.textContent = `${(file.size / 1024).toFixed(1)} KB`;
        if (info) info.style.display = 'block';
        const reader = new FileReader();
        reader.onload = () => {
            area.classList.remove('is-loading');
            area.textContent = '✅ Đã nạp file phôi';
            if (preview && /^image\//.test(file.type)) {
                preview.src = reader.result;
                preview.style.display = 'block';
            }
            _showCtrlMsg(`✅ Đã đọc file ${file.name}`, 'var(--status-active)');
        };
        reader.onerror = () => {
            area.classList.remove('is-loading');
            area.textContent = '📂 Upload STL / STEP / PNG';
            _showCtrlMsg('❌ Không đọc được file phôi', 'var(--status-alarm)');
        };
        if (/^image\//.test(file.type)) reader.readAsDataURL(file);
        else reader.readAsText(file.slice(0, Math.min(file.size, 128 * 1024)));
    });
}

document.addEventListener('DOMContentLoaded', initWorkpieceUploadFeedback);

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════

window.setGCodeFromAI   = setGCodeFromAI;
window.downloadGCode    = downloadGCode;
window.clearGCode       = clearGCode;
window.sendGcodeToQueue = sendGcodeToQueue;
window.loadGCodeFile    = loadGCodeFile;
window.askAiAboutGCode  = askAiAboutGCode;
window.tp3dToggleGrid   = tp3dToggleGrid;
window.tp3dToggleAxes   = tp3dToggleAxes;
window.tp3dToggleBox    = tp3dToggleBox;
window.tp3dToggleZPlane = tp3dToggleZPlane;
window.tp3dReset        = tp3dReset;
window.tp3dSimulate     = tp3dSimulate;
window.tp3dStop         = tp3dStop;
window.tp3dResetSim     = tp3dResetSim;