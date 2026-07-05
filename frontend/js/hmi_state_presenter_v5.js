/**
 * HMI V9 single state presenter.
 *
 * One and only one runtime owns /ws/pose and /api/pose/latest for the HMI.
 * It converts backend/control-selector state into operator-first messages and
 * also updates legacy element IDs that remain in dashboard/control/monitor.
 */
import { api } from '/static/js/api.js';

const $ = (id) => document.getElementById(id);
const setText = (id, value) => { const n = $(id); if (n) n.textContent = value ?? '---'; };
const norm = (v) => String(v ?? '').trim();
const upper = (v) => norm(v).toUpperCase();

function normalizePayload(payload = {}) {
  const p = payload.payload || payload;
  const mpos = p.mpos || p.position || {};
  const state = p.state || p.machine_state || p.status || '---';
  return {
    source: p.source || p.control_owner || 'cloud_boot',
    owner: p.control_owner || p.owner || p.source || 'unknown',
    sync: p.sync_status || p.sync || 'UNKNOWN',
    epoch: p.sync_epoch_id || p.epoch || '---',
    check: p.gcode_check_status || p.check_status || p.check || '---',
    run: p.run_permission || p.run || 'UNKNOWN',
    state,
    ai: p.ai_approval_status || p.ai || (p.ai_approved ? 'APPROVED' : 'WAIT'),
    collision: Boolean(p.collision),
    alarm: Boolean(p.alarm) || upper(state).includes('ALARM') || upper(state).includes('ESTOP'),
    mpos: {
      x: Number(mpos.x ?? mpos[0] ?? 0),
      y: Number(mpos.y ?? mpos[1] ?? 0),
      z: Number(mpos.z ?? mpos[2] ?? 0),
    },
    raw: p,
  };
}

function isRunning(s) {
  return ['RUN', 'RUNNING', 'CYCLE'].some(x => upper(s.state) === x || upper(s.run).includes(x));
}

function isReady(s) {
  return upper(s.run) === 'READY' || (
    upper(s.sync) === 'MACHINE_NX_SYNCED' &&
    upper(s.check) === 'PASSED' &&
    !s.alarm && !s.collision &&
    (upper(s.ai) === 'APPROVED' || s.raw.ai_approved === true)
  );
}

function statusClass(value) {
  const v = upper(value);
  if (v.includes('ALARM') || v.includes('FAILED') || v.includes('ESTOP') || v.includes('COLLISION')) return 'alarm';
  if (v.includes('RUN') || v.includes('CYCLE')) return 'running';
  if (v.includes('STALE') || v.includes('UNSYNC') || v.includes('BLOCK') || v.includes('UNKNOWN') || v === '---') return 'warn';
  if (v.includes('SYNCED') || v.includes('READY') || v.includes('PASSED') || v.includes('IDLE') || v.includes('OK') || v.includes('APPROVED')) return 'ok';
  return 'unknown';
}

function operatorBlockedReasons(s) {
  const reasons = [];
  if (s.alarm) reasons.push('Đang có cảnh báo hoặc dừng khẩn. Xử lý lỗi trước.');
  if (s.collision) reasons.push('Mô phỏng phát hiện nguy cơ va chạm. Không chạy máy thật.');
  if (upper(s.sync) !== 'MACHINE_NX_SYNCED') reasons.push('Chưa cài đặt gốc tọa độ và đồng bộ máy thật với mô phỏng.');
  if (upper(s.check) !== 'PASSED') reasons.push('G-code chưa được kiểm tra an toàn trong phiên hiện tại.');
  if (!(upper(s.ai) === 'APPROVED' || s.raw.ai_approved === true)) reasons.push('Chưa có phê duyệt chạy thật từ AI hoặc người vận hành.');
  if (!reasons.length && upper(s.run) !== 'READY') reasons.push('Run Gate chưa xác nhận READY từ backend.');
  return reasons.slice(0, 4);
}

function engineerBlockedReasons(s) {
  const reasons = [];
  if (s.alarm) reasons.push('Alarm/ESTOP active in machine state.');
  if (s.collision) reasons.push('Collision flag true from CHECK/control selector.');
  if (upper(s.sync) !== 'MACHINE_NX_SYNCED') reasons.push('FluidNC ↔ NX MCD sync_epoch chưa MACHINE_NX_SYNCED.');
  if (upper(s.check) !== 'PASSED') reasons.push('G-code CHECK chưa PASSED hoặc đã STALE.');
  if (!(upper(s.ai) === 'APPROVED' || s.raw.ai_approved === true)) reasons.push('AI approval status chưa APPROVED.');
  if (!reasons.length && upper(s.run) !== 'READY') reasons.push('run_permission != READY.');
  return reasons.slice(0, 4);
}

function activeReasons(s) {
  return document.body.classList.contains('engineer-mode') ? engineerBlockedReasons(s) : operatorBlockedReasons(s);
}

function nextAction(s, reasons) {
  const joined = reasons.join(' ').toLowerCase();
  if (joined.includes('dừng') || joined.includes('alarm') || joined.includes('cảnh báo')) return 'Xử lý cảnh báo/dừng khẩn trước khi thao tác tiếp.';
  if (joined.includes('gốc tọa độ') || joined.includes('đồng bộ')) return 'Nhấn HOME & SYNC để đồng bộ máy thật với mô phỏng.';
  if (joined.includes('g-code')) return 'Chạy G-code CHECK trước khi mở RUN.';
  if (joined.includes('phê duyệt')) return 'Xem kết quả CHECK và phê duyệt chạy thật.';
  if (isReady(s)) return 'Có thể chuyển sang Control và RUN theo quy trình.';
  return 'Kiểm tra các điều kiện trong Run Permission Gate.';
}

function sourcePresentation(source) {
  const src = norm(source);
  switch (src) {
    case 'stream_fluidnc':
      return { label: 'Đang hiển thị: MÁY THẬT', note: 'Pose 3D lấy từ FluidNC realtime. Đây là chuyển động máy thật.', kind: 'ready' };
    case 'idle_fluidnc':
      return { label: 'Đang hiển thị: MÁY THẬT ĐANG IDLE/JOG', note: 'Frontend mirror MPos khi máy đứng yên hoặc jog.', kind: 'ready' };
    case 'matlab_check':
      return { label: 'Đang hiển thị: MÔ PHỎNG KIỂM TRA G-CODE', note: 'Không phải chuyển động máy thật. Đây là trajectory CHECK từ MATLAB/NX.', kind: 'warn' };
    case 'home_sync':
      return { label: 'Đang hiển thị: ĐỒNG BỘ HOME', note: 'NX MCD đang được đưa về pose đồng bộ với FluidNC.', kind: 'warn' };
    case 'manual_calibration':
      return { label: 'Đang hiển thị: HIỆU CHUẨN THỦ CÔNG', note: 'Không phát lệnh máy thật. Chỉ dùng để căn chỉnh 3D.', kind: 'warn' };
    default:
      return { label: 'Đang hiển thị: CHƯA CÓ DỮ LIỆU MÁY THẬT', note: 'Chưa nhận selected pose từ Control Selector.', kind: 'warn' };
  }
}

function setRunButtonsReady(ready) {
  window.__hmiRunReady = Boolean(ready);
  document.body.dataset.runReady = ready ? 'true' : 'false';
  document.querySelectorAll('.operator-run-action, #runAllBtn, [data-run-action="true"]').forEach(btn => {
    btn.disabled = !ready;
    btn.dataset.runReady = ready ? 'true' : 'false';
    btn.setAttribute('aria-disabled', String(!ready));
    btn.classList.toggle('ready', ready);
    btn.classList.toggle('blocked', !ready);
    btn.title = ready ? 'RUN đã được mở bởi Run Permission Gate' : 'RUN bị khóa: cần đủ Home Sync, CHECK, Approval và No Alarm';
  });
  const big = $('operatorRunButton');
  if (big) {
    big.disabled = !ready;
    big.classList.toggle('ready', ready);
    big.textContent = ready ? 'RUN READY' : 'RUN BỊ KHÓA';
  }
}

function setChip(id, state, label) {
  const n = $(id);
  if (!n) return;
  const cls = statusClass(state);
  n.classList.remove('ok', 'warn', 'alarm', 'unknown', 'running');
  n.classList.add(cls === 'running' ? 'warn' : cls);
  const strong = n.querySelector('strong');
  if (strong) strong.textContent = label || state || '---';
}

function setStep(id, state) {
  const el = $(id); if (!el) return;
  el.classList.remove('state-ok','state-wait','state-alarm','ok','warn','alarm','unknown');
  const cls = statusClass(state);
  el.classList.add(cls === 'ok' ? 'state-ok' : cls === 'alarm' ? 'state-alarm' : 'state-wait');
  const st = el.querySelector('.operator-step-state, .hmi-step-state, .state');
  if (st) st.textContent = state || 'WAIT';
}

function renderReasons(list) {
  if (!list.length) return '<li>Tất cả điều kiện chính đã hợp lệ.</li>';
  return list.map(r => `<li>${r}</li>`).join('');
}

function updateLegacyFields(s, ready, statusClassName) {
  setText('hmiSyncStatus', s.sync);
  setText('hmiOwner', s.owner);
  setText('hmiEpoch', s.epoch);
  setText('hmiCheck', s.check);
  setText('hmiRun', s.run);
  setText('hmiSource', s.source);
  setText('hmiMachineState', s.state);
  setText('hmiControlOwner', s.owner);
  setText('hmiControlEpoch', s.epoch);
  setText('hmiControlSync', s.sync);
  setText('hmiControlCheck', s.check);
  setText('hmiRunPermit', ready ? 'RUN READY' : 'RUN BLOCKED');

  const m = s.mpos || {};
  if (!Number.isNaN(m.x)) setText('hmiMposX', Number(m.x).toFixed(2));
  if (!Number.isNaN(m.y)) setText('hmiMposY', Number(m.y).toFixed(2));
  if (!Number.isNaN(m.z)) setText('hmiMposZ', Number(m.z).toFixed(2));

  setChip('chkFluidIdle', upper(s.state) === 'IDLE' ? 'OK' : isRunning(s) ? 'RUN' : 'WAIT', upper(s.state) === 'IDLE' ? 'Idle' : isRunning(s) ? 'Run' : 'WAIT');
  setChip('chkHomeSync', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'OK' : 'WAIT', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'Synced' : 'WAIT');
  setChip('chkNxReady', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'OK' : 'WAIT', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'Ready' : 'WAIT');
  setChip('chkGcode', upper(s.check) === 'PASSED' ? 'OK' : upper(s.check) === 'FAILED' ? 'ALARM' : 'WAIT', s.check || 'WAIT');
  setChip('chkAi', upper(s.ai) === 'APPROVED' ? 'OK' : 'WAIT', upper(s.ai) === 'APPROVED' ? 'Approved' : 'WAIT');
  setChip('chkAlarm', s.alarm || s.collision ? 'ALARM' : 'OK', s.alarm || s.collision ? 'Alarm' : 'No Alarm');

  const priorityDot = $('hmiPriorityDot');
  if (priorityDot) priorityDot.className = `run-status-dot ${statusClassName === 'ready' ? 'ok' : statusClassName === 'alarm' ? 'alarm' : 'warn'}`;
  const strip = $('opControlStatus');
  if (strip) strip.classList.toggle('is-running', isRunning(s));

  setStep('stepHome', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'Đạt' : 'Chờ');
  setStep('stepNx', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'Đạt' : 'Chờ');
  setStep('stepCheck', upper(s.check) === 'PASSED' ? 'Đạt' : upper(s.check) === 'FAILED' ? 'Lỗi' : 'Chờ');
  setStep('stepAi', upper(s.ai) === 'APPROVED' ? 'Đạt' : 'Chờ');
  setStep('stepRun', ready ? 'Mở' : 'Khóa');
  setStep('stepLog', s.raw.run_id ? 'Ghi' : 'Chờ');
}

function applyOperatorState(payload) {
  const s = normalizePayload(payload);
  const ready = isReady(s);
  const running = isRunning(s);
  const reasons = ready ? [] : activeReasons(s);
  const action = nextAction(s, reasons);
  const source = sourcePresentation(s.source);
  const statusClassName = s.alarm || s.collision ? 'alarm' : running ? 'running' : ready ? 'ready' : 'blocked';

  document.body.classList.toggle('machine-running', running);
  setText('opRunTitle', ready ? 'ĐƯỢC PHÉP CHẠY MÁY' : 'CHƯA ĐƯỢC CHẠY MÁY');
  setText('opRunSubtitle', ready ? 'Máy thật và mô phỏng đã đồng bộ, G-code đã hợp lệ cho phiên hiện tại.' : 'Hệ thống đang khóa RUN để tránh chạy sai trạng thái hoặc dùng kết quả CHECK đã cũ.');
  const reasonEl = $('opBlockedReasons');
  if (reasonEl) reasonEl.innerHTML = renderReasons(reasons);
  setText('opNextAction', action);
  setText('opSourceLabel', running ? 'ĐANG GIA CÔNG — đang nhận chuyển động máy thật' : source.label);
  setText('opSourceNote', running ? 'Máy đang chạy thật. Luôn quan sát 3D, âm thanh máy và sẵn sàng ESTOP.' : source.note);
  setText('opSourceRaw', s.source);
  setText('opEpoch', s.epoch);
  setText('opSync', s.sync);
  setText('opCheck', s.check);
  setText('opOwner', s.owner);
  setText('opRunRaw', s.run);

  ['opRunCard','opControlStatus'].forEach(id => {
    const n = $(id); if (!n) return;
    n.classList.remove('ready','blocked','alarm','running','is-running','is-ready','is-alarm');
    n.classList.add(statusClassName);
    if (running) n.classList.add('is-running');
    if (ready) n.classList.add('is-ready');
    if (statusClassName === 'alarm') n.classList.add('is-alarm');
  });
  const title = $('opRunTitle');
  if (title) title.className = `operator-run-title ${statusClassName}`;
  const dot = $('opSourceDot');
  if (dot) dot.className = `operator-source-dot ${source.kind === 'ready' ? 'ready' : statusClassName === 'alarm' ? 'alarm' : ''}`;

  setText('opMonitorSourceLabel', running ? 'Đang hiển thị: MÁY THẬT ĐANG GIA CÔNG' : source.label);
  setText('opMonitorSourceNote', running ? 'Đây là chuyển động máy thật. Không phải mô phỏng kiểm tra.' : source.note);
  setText('opMonitorRun', ready ? 'READY' : running ? 'RUNNING' : 'BLOCKED');
  setText('opMonitorSync', s.sync);
  setText('opMonitorCheck', s.check);
  setText('opControlTitle', running ? 'ĐANG GIA CÔNG' : ready ? 'ĐƯỢC PHÉP CHẠY MÁY' : 'RUN ĐANG BỊ KHÓA');
  setText('opControlNext', action);
  const ctrlReasons = $('opControlReasons');
  if (ctrlReasons) ctrlReasons.innerHTML = renderReasons(reasons);
  setText('opMposCompact', `X ${s.mpos.x.toFixed(2)} · Y ${s.mpos.y.toFixed(2)} · Z ${s.mpos.z.toFixed(2)} mm`);
  updateSteps(s, ready);
  setRunButtonsReady(ready && !running);
  updateLegacyFields(s, ready, statusClassName);
}

function updateSteps(s, ready) {
  const pairs = [
    ['opStepHome', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'Đạt' : 'Chờ'],
    ['opStepCheck', upper(s.check) === 'PASSED' ? 'Đạt' : 'Chờ'],
    ['opStepAi', (upper(s.ai) === 'APPROVED' || s.raw.ai_approved === true) ? 'Đạt' : 'Chờ'],
    ['opStepRun', ready ? 'Mở' : 'Khóa'],
    ['opStepMonitor', s.raw.run_id ? 'Ghi' : 'Chờ'],
  ];
  for (const [id, state] of pairs) setStep(id, state);
}

function setMode(mode) {
  const engineer = mode === 'engineer';
  document.body.classList.toggle('engineer-mode', engineer);
  document.body.classList.toggle('operator-mode', !engineer);
  localStorage.setItem('hmi_mode_v5', engineer ? 'engineer' : 'operator');
  document.querySelectorAll('[data-hmi-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.hmiMode === (engineer ? 'engineer' : 'operator')));
  if (window.__lastHmiPayload) applyOperatorState(window.__lastHmiPayload);
}
window.setHmiModeV5 = setMode;
window.applyHmiOperatorState = applyOperatorState;

async function fetchLatestPose() {
  try {
    const d = await api.get('/api/pose/latest');
    const p = d && (d.payload || d.mpos || d.sync_epoch_id || d.source) ? (d.payload || d) : { source:'cloud_boot', run_permission:'UNKNOWN', sync_status:'UNKNOWN' };
    window.__lastHmiPayload = p;
    applyOperatorState(p);
  } catch (_) {
    const p = { source:'cloud_boot', run_permission:'UNKNOWN', sync_status:'UNKNOWN' };
    window.__lastHmiPayload = p;
    applyOperatorState(p);
  }
}
function connectWs() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${window.location.host}/ws/pose`;
  let timer;
  const go = () => {
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const p = msg.payload || msg;
        window.__lastHmiPayload = p;
        applyOperatorState(p);
      } catch (_) {}
    };
    ws.onclose = () => { clearTimeout(timer); timer = setTimeout(go, 2000); };
    ws.onerror = () => ws.close();
  };
  try { go(); } catch (_) {}
}

async function refreshProviderBadge() {
  try {
    const status = await api.get('/api/ai/provider/status');
    const badge = $('aiProvBadge');
    if (badge && status?.provider) {
      badge.textContent = `${status.provider} ▾`;
      badge.title = `AI provider: ${status.provider} · tier: ${status.tier || 'unknown'}`;
    }
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {
  setMode(localStorage.getItem('hmi_mode_v5') || 'operator');
  const boot = { source:'cloud_boot', run_permission:'UNKNOWN', sync_status:'UNKNOWN', check_status:'---' };
  window.__lastHmiPayload = boot;
  applyOperatorState(boot);
  refreshProviderBadge();
  fetchLatestPose();
  setInterval(fetchLatestPose, 3000);
  connectWs();
});
