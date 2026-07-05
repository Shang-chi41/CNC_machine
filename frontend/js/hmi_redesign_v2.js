/**
 * HMI Redesign V2 shared runtime.
 * Read-only sync/run gate renderer for dashboard, monitor, and control.
 * It deliberately does not send machine commands.
 */
import { api } from '/static/js/api.js';

function el(id) { return document.getElementById(id); }
function text(id, value) { const n = el(id); if (n) n.textContent = value ?? '---'; }

function statusClass(value) {
    const v = String(value || '').toUpperCase();
    if (v.includes('ALARM') || v.includes('FAILED') || v.includes('ESTOP') || v.includes('COLLISION')) return 'alarm';
    if (v.includes('STALE') || v.includes('UNSYNC') || v.includes('BLOCK') || v.includes('UNKNOWN') || v === '---') return 'warn';
    if (v.includes('SYNCED') || v.includes('READY') || v.includes('PASSED') || v.includes('IDLE') || v.includes('OK')) return 'ok';
    return 'unknown';
}

function setClass(id, base, cls) {
    const n = el(id);
    if (n) n.className = `${base} ${cls}`;
}

function setStep(id, state) {
    const n = el(id);
    if (!n) return;
    const cls = statusClass(state);
    n.classList.remove('ok', 'warn', 'alarm', 'unknown');
    n.classList.add(cls);
    const s = n.querySelector('.hmi-step-state, .state');
    if (s) s.textContent = state || 'UNKNOWN';
}

function setCheck(id, state) {
    const n = el(id);
    if (!n) return;
    const cls = statusClass(state);
    n.classList.remove('ok', 'warn', 'alarm', 'unknown');
    n.classList.add(cls);
}

function normalizePose(payload = {}) {
    const p = payload.payload || payload;
    return {
        source: p.source || p.control_owner || '---',
        owner: p.control_owner || p.source || '---',
        epoch: p.sync_epoch_id || '---',
        sync: p.sync_status || 'UNKNOWN',
        check: p.gcode_check_status || p.check_status || '---',
        run: p.run_permission || 'BLOCKED',
        state: p.state || p.machine_state || '---',
        collision: Boolean(p.collision),
        alarm: p.alarm || p.state === 'Alarm',
        mpos: p.mpos || p.position || {},
        feed: p.feed,
        spindle: p.spindle,
        raw: p,
    };
}

function applyPose(payload) {
    const s = normalizePose(payload);
    text('hmiSyncStatus', s.sync);
    text('hmiOwner', s.owner);
    text('hmiEpoch', s.epoch);
    text('hmiCheck', s.check);
    text('hmiRun', s.run);
    text('hmiSource', s.source);
    text('hmiMachineState', s.state);
    text('hmiControlOwner', s.owner);
    text('hmiControlEpoch', s.epoch);
    text('hmiControlSync', s.sync);
    text('hmiControlCheck', s.check);
    text('hmiPriorityText', priorityText(s));
    text('hmiPrioritySource', `SOURCE ${s.source}`);
    text('hmiPriorityEpoch', `EPOCH ${s.epoch}`);
    text('hmiPriorityRun', `RUN ${s.run}`);

    const m = s.mpos || {};
    if (m.x !== undefined) text('hmiMposX', Number(m.x).toFixed(2));
    if (m.y !== undefined) text('hmiMposY', Number(m.y).toFixed(2));
    if (m.z !== undefined) text('hmiMposZ', Number(m.z).toFixed(2));

    const syncCls = statusClass(s.sync);
    const runCls = s.run === 'READY' ? 'ok' : s.collision || s.alarm ? 'alarm' : 'warn';
    setClass('hmiTileSync', 'hmi-tile', syncCls);
    setClass('hmiTileOwner', 'hmi-tile', statusClass(s.owner));
    setClass('hmiTileCheck', 'hmi-tile', statusClass(s.check));
    setClass('hmiTileRun', 'hmi-tile', runCls === 'ok' ? 'ok run-ready' : runCls === 'alarm' ? 'alarm run-alarm' : 'warn run-blocked');
    setClass('hmiPriorityDot', 'hmi-priority-dot', runCls);

    const permit = el('hmiRunPermit');
    if (permit) {
        permit.textContent = s.run === 'READY' ? 'RUN READY' : 'RUN BLOCKED';
        permit.className = `hmi-run-permit ${runCls === 'ok' ? 'ready' : runCls === 'alarm' ? 'alarm' : ''}`;
    }

    const score = readinessScore(s);
    text('hmiReadinessScore', `${score}%`);
    const ring = el('hmiReadinessRing');
    if (ring) {
        ring.className = `hmi-score-ring ${score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'alarm'}`;
    }

    setStep('stepHome', s.sync === 'MACHINE_NX_SYNCED' ? 'SYNCED' : 'WAIT');
    setStep('stepNx', s.sync === 'MACHINE_NX_SYNCED' ? 'CONFIRMED' : 'WAIT');
    setStep('stepCheck', s.check || 'WAIT');
    setStep('stepAi', s.raw.ai_approval_status || (s.check === 'PASSED' ? 'WAIT APPROVAL' : 'WAIT'));
    setStep('stepRun', s.run || 'BLOCKED');
    setStep('stepLog', s.raw.run_id ? 'LOGGING' : 'WAIT');

    setCheck('chkFluidIdle', s.state === 'Idle' || s.state === 'IDLE' ? 'OK' : 'WAIT');
    setCheck('chkHomeSync', s.sync === 'MACHINE_NX_SYNCED' ? 'OK' : 'WAIT');
    setCheck('chkNxReady', s.sync === 'MACHINE_NX_SYNCED' ? 'OK' : 'WAIT');
    setCheck('chkGcode', s.check === 'PASSED' ? 'OK' : s.check === 'FAILED' ? 'ALARM' : 'WAIT');
    setCheck('chkAi', s.raw.ai_approval_status === 'APPROVED' ? 'OK' : 'WAIT');
    setCheck('chkAlarm', s.alarm || s.collision ? 'ALARM' : 'OK');
}

function readinessScore(s) {
    let score = 0;
    if (s.sync === 'MACHINE_NX_SYNCED') score += 30;
    if (s.check === 'PASSED') score += 25;
    if (s.run === 'READY') score += 25;
    if (!s.alarm && !s.collision) score += 20;
    return score;
}

function priorityText(s) {
    if (s.collision) return 'COLLISION / CHECK FAILED — kiểm tra bị chặn';
    if (s.alarm) return 'ALARM — ưu tiên xử lý bất thường trước';
    if (s.run === 'READY') return 'READY — điều kiện chạy đã hợp lệ cho epoch hiện tại';
    if (s.sync !== 'MACHINE_NX_SYNCED') return 'BLOCKED — máy thật và NX MCD chưa đồng bộ';
    if (s.check !== 'PASSED') return 'BLOCKED — G-code chưa có CHECK hợp lệ';
    return 'BLOCKED — chờ đủ điều kiện vận hành';
}

async function fetchLatestPose() {
    try {
        const d = await api.get('/api/pose/latest');
        if (d && (d.payload || d.mpos || d.sync_epoch_id)) applyPose(d.payload || d);
    } catch (_) {}
}

function connectPoseWs() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws/pose`;
    let timer = null;
    const connect = () => {
        const ws = new WebSocket(url);
        ws.onmessage = ev => {
            try { applyPose(JSON.parse(ev.data)); } catch (_) {}
        };
        ws.onclose = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(connect, 2000);
        };
        ws.onerror = () => ws.close();
    };
    try { connect(); } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {
    fetchLatestPose();
    setInterval(fetchLatestPose, 2500);
    connectPoseWs();
});
