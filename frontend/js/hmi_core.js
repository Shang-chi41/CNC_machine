/** Shared HMI Core behaviors: AI panel collapse + small accessibility helpers. */
function initAiCollapse() {
  document.querySelectorAll('.ai-panel .ai-header').forEach((header) => {
    if (header.querySelector('.ai-collapse-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-collapse-btn';
    btn.setAttribute('aria-label', 'Ẩn hoặc hiện AI Assistant');
    btn.setAttribute('aria-expanded', String(!document.body.classList.contains('ai-collapsed')));
    btn.textContent = '◂';
    btn.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('ai-collapsed');
      localStorage.setItem('hmi_ai_collapsed', collapsed ? '1' : '0');
      btn.textContent = collapsed ? '▸' : '◂';
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
    header.appendChild(btn);
  });
  if (localStorage.getItem('hmi_ai_collapsed') === '1') {
    document.body.classList.add('ai-collapsed');
    document.querySelectorAll('.ai-collapse-btn').forEach(btn => { btn.textContent = '▸'; btn.setAttribute('aria-expanded', 'false'); });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAiCollapse();
});
