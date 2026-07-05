
/**
 * HMI V5 Operator-first state presenter.
 * Converts raw sync/control state into operator decisions:
 * - Can the real machine run?
 * - Why is it blocked?
 * - What is the next safe action?
 * - Is 3D showing the real machine or a simulation/check trajectory?
 */
import { api } from '/static/js/api.js';

const $ = (id) => document.getElementById(id);
const setText = (id, value) => { const n = $(id); if (n) n.textContent = value ?? '---'; };
const norm = (v) => String(v ?? '').trim();
const upper = (v) => norm(v).toUpperCase();

function normalizePayload(payload = {}) {
  const p = payload.payload || payload;
  const mpos = p.mpos || p.position || {};
  return {
    source: p.source || p.control_owner || 'cloud_boot',
    owner: p.control_owner || p.owner || p.source || 'unknown',
    sync: p.sync_status || p.sync || 'UNKNOWN',
    epoch: p.sync_epoch_id || p.epoch || '---',
    check: p.gcode_check_status || p.check_status || p.check || '---',
    run: p.run_permission || p.run || 'UNKNOWN',
    state: p.state || p.machine_state || '---',
    ai: p.ai_approval_status || p.ai || 'WAIT',
    collision: Boolean(p.collision),
    alarm: Boolean(p.alarm) || upper(p.state).includes('ALARM'),
    mpos: {
      x: Number(mpos.x ?? mpos[0] ?? 0),
      y: Number(mpos.y ?? mpos[1] ?? 0),
      z: Number(mpos.z ?? mpos[2] ?? 0),
    },
    raw: p,
  };
}

function isReady(s) {
  return upper(s.run) === 'READY' || (
    upper(s.sync) === 'MACHINE_NX_SYNCED' &&
    upper(s.check) === 'PASSED' &&
    !s.alarm && !s.collision &&
    (upper(s.ai) === 'APPROVED' || s.raw.ai_approved === true)
  );
}

function blockedReasons(s) {
  const reasons = [];
  if (s.alarm) reasons.push('Đang có alarm/cảnh báo trên hệ thống.');
  if (s.collision) reasons.push('Có tín hiệu collision hoặc CHECK phát hiện va chạm.');
  if (upper(s.sync) !== 'MACHINE_NX_SYNCED') reasons.push('Máy thật và NX MCD chưa đồng bộ Home/pose.');
  if (upper(s.check) !== 'PASSED') reasons.push('G-code chưa được CHECK đạt trong phiên đồng bộ hiện tại.');
  if (!(upper(s.ai) === 'APPROVED' || s.raw.ai_approved === true)) reasons.push('AI hoặc người vận hành chưa phê duyệt chạy thật.');
  if (!reasons.length && upper(s.run) !== 'READY') reasons.push('Run Gate chưa xác nhận READY từ backend.');
  return reasons.slice(0, 4);
}

function nextAction(s, reasons) {
  const joined = reasons.join(' ').toLowerCase();
  if (joined.includes('alarm') || joined.includes('cảnh báo')) return 'Xử lý alarm trước khi thao tác tiếp.';
  if (joined.includes('đồng bộ')) return 'Nhấn HOME & SYNC để đồng bộ máy thật với NX MCD.';
  if (joined.includes('g-code')) return 'Chạy G-code CHECK bằng MATLAB/NX MCD.';
  if (joined.includes('phê duyệt')) return 'Xem kết quả CHECK và phê duyệt trước khi RUN.';
  if (isReady(s)) return 'Có thể chuyển sang Control và RUN theo quy trình.';
  return 'Kiểm tra từng điều kiện trong Run Permission Gate.';
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
  document.querySelectorAll('.operator-run-action, #runAllBtn, [data-run-action="true"]').forEach(btn => {
    btn.disabled = !ready;
    btn.setAttribute('aria-disabled', String(!ready));
    btn.classList.toggle('ready', ready);
    btn.title = ready ? 'RUN đã được mở bởi Run Permission Gate' : 'RUN bị khóa: cần đủ Home Sync, CHECK, Approval và No Alarm';
  });
  const big = $('operatorRunButton');
  if (big) {
    big.disabled = !ready;
    big.classList.toggle('ready', ready);
    big.textContent = ready ? 'RUN READY' : 'RUN BỊ KHÓA';
  }
}

function renderReasons(list) {
  if (!list.length) return '<li>Tất cả điều kiện chính đã hợp lệ.</li>';
  return list.map(r => `<li>${r}</li>`).join('');
}

function applyOperatorState(payload) {
  const s = normalizePayload(payload);
  const ready = isReady(s);
  const reasons = ready ? [] : blockedReasons(s);
  const action = nextAction(s, reasons);
  const source = sourcePresentation(s.source);
  const statusClass = s.alarm || s.collision ? 'alarm' : ready ? 'ready' : 'blocked';

  setText('opRunTitle', ready ? 'ĐƯỢC PHÉP CHẠY MÁY' : 'CHƯA ĐƯỢC CHẠY MÁY');
  setText('opRunSubtitle', ready ? 'Máy thật và mô phỏng đã đồng bộ, G-code đã hợp lệ cho phiên hiện tại.' : 'Hệ thống đang khóa RUN để tránh chạy sai trạng thái hoặc dùng kết quả CHECK đã cũ.');
  const reasonEl = $('opBlockedReasons');
  if (reasonEl) reasonEl.innerHTML = renderReasons(reasons);
  setText('opNextAction', action);
  setText('opSourceLabel', source.label);
  setText('opSourceNote', source.note);
  setText('opSourceRaw', s.source);
  setText('opEpoch', s.epoch);
  setText('opSync', s.sync);
  setText('opCheck', s.check);
  setText('opOwner', s.owner);
  setText('opRunRaw', s.run);
  ['opRunCard','opControlStatus'].forEach(id => {
    const n = $(id); if (n) n.className = n.className.replace(/\b(ready|blocked|alarm)\b/g,'').trim() + ' ' + statusClass;
  });
  const title = $('opRunTitle');
  if (title) title.className = `operator-run-title ${statusClass}`;
  const dot = $('opSourceDot');
  if (dot) dot.className = `operator-source-dot ${source.kind === 'ready' ? 'ready' : statusClass === 'alarm' ? 'alarm' : ''}`;
  setText('opMonitorSourceLabel', source.label);
  setText('opMonitorSourceNote', source.note);
  setText('opMonitorRun', ready ? 'READY' : 'BLOCKED');
  setText('opMonitorSync', s.sync);
  setText('opMonitorCheck', s.check);
  setText('opControlTitle', ready ? 'ĐƯỢC PHÉP CHẠY MÁY' : 'RUN ĐANG BỊ KHÓA');
  setText('opControlNext', action);
  const ctrlReasons = $('opControlReasons');
  if (ctrlReasons) ctrlReasons.innerHTML = renderReasons(reasons);
  setText('opMposCompact', `X ${s.mpos.x.toFixed(2)} · Y ${s.mpos.y.toFixed(2)} · Z ${s.mpos.z.toFixed(2)} mm`);
  updateSteps(s, ready);
  setRunButtonsReady(ready);
}

function updateSteps(s, ready) {
  const pairs = [
    ['opStepHome', upper(s.sync) === 'MACHINE_NX_SYNCED' ? 'Đạt' : 'Chờ'],
    ['opStepCheck', upper(s.check) === 'PASSED' ? 'Đạt' : 'Chờ'],
    ['opStepAi', (upper(s.ai) === 'APPROVED' || s.raw.ai_approved === true) ? 'Đạt' : 'Chờ'],
    ['opStepRun', ready ? 'Mở' : 'Khóa'],
    ['opStepMonitor', s.raw.run_id ? 'Ghi' : 'Chờ'],
  ];
  for (const [id, state] of pairs) {
    const el = $(id); if (!el) continue;
    el.classList.remove('state-ok','state-wait','state-alarm');
    el.classList.add(state === 'Đạt' || state === 'Mở' || state === 'Ghi' ? 'state-ok' : 'state-wait');
    const st = el.querySelector('.operator-step-state'); if (st) st.textContent = state;
  }
}

function setMode(mode) {
  const engineer = mode === 'engineer';
  document.body.classList.toggle('engineer-mode', engineer);
  document.body.classList.toggle('operator-mode', !engineer);
  localStorage.setItem('hmi_mode_v5', engineer ? 'engineer' : 'operator');
  document.querySelectorAll('[data-hmi-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.hmiMode === (engineer ? 'engineer' : 'operator')));
}
window.setHmiModeV5 = setMode;

async function fetchLatestPose() {
  try {
    const d = await api.get('/api/pose/latest');
    if (d && (d.payload || d.mpos || d.sync_epoch_id || d.source)) applyOperatorState(d.payload || d);
  } catch (_) {
    applyOperatorState({ source:'cloud_boot', run_permission:'UNKNOWN', sync_status:'UNKNOWN' });
  }
}
function connectWs() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${window.location.host}/ws/pose`;
  let timer;
  const go = () => {
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => { try { applyOperatorState(JSON.parse(ev.data)); } catch (_) {} };
    ws.onclose = () => { clearTimeout(timer); timer = setTimeout(go, 2000); };
    ws.onerror = () => ws.close();
  };
  try { go(); } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {
  setMode(localStorage.getItem('hmi_mode_v5') || 'operator');
  applyOperatorState({ source:'cloud_boot', run_permission:'UNKNOWN', sync_status:'UNKNOWN', check_status:'---' });
  fetchLatestPose();
  setInterval(fetchLatestPose, 3000);
  connectWs();
});
