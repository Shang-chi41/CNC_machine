/** Shared HMI Core behaviors V10: AI panel collapse + operator-first accessibility helpers. */
function applyAiCollapsed(collapsed) {
  document.body.classList.toggle('ai-collapsed', collapsed);
  localStorage.setItem('hmi_ai_collapsed', collapsed ? '1' : '0');
  document.querySelectorAll('.ai-collapse-btn').forEach(btn => {
    btn.textContent = collapsed ? '▸' : '◂';
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
}

window.setAiCollapsed = applyAiCollapsed;

function initAiCollapse() {
  document.querySelectorAll('.ai-panel .ai-header').forEach((header) => {
    if (header.querySelector('.ai-collapse-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-collapse-btn';
    btn.setAttribute('aria-label', 'Ẩn hoặc hiện AI Assistant');
    btn.setAttribute('aria-expanded', String(!document.body.classList.contains('ai-collapsed')));
    btn.textContent = '◂';
    btn.addEventListener('click', () => applyAiCollapsed(!document.body.classList.contains('ai-collapsed')));
    header.appendChild(btn);
  });

  const stored = localStorage.getItem('hmi_ai_collapsed');
  const defaultCollapsed = document.body.classList.contains('page-control') && !window.location.hash.includes('ai');
  if (stored === '1' || (stored === null && defaultCollapsed)) applyAiCollapsed(true);
  else applyAiCollapsed(false);
}

document.addEventListener('DOMContentLoaded', () => {
  initAiCollapse();
});
