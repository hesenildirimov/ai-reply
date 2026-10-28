// Hover/focus tooltip for the daily bar chart. Values come from data-* attributes and are inserted with textContent.
(() => {
  document.querySelectorAll('.chart-wrap').forEach((wrap) => {
    const tip = wrap.querySelector('.tip');
    const svg = wrap.querySelector('svg');
    if (!tip || !svg) return;
    const show = (g) => {
      wrap.querySelectorAll('.col.on').forEach((x) => {
        x.classList.remove('on');
      });
      g.classList.add('on');
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'tip-head';
      head.textContent = g.dataset.day;
      tip.append(head);
      for (const [cls, label, v] of [
        ['s1', 'Gələn', g.dataset.a],
        ['s2', 'Gedən', g.dataset.b],
      ]) {
        const row = document.createElement('div');
        const key = document.createElement('i');
        key.className = `line-key ${cls}`;
        const val = document.createElement('b');
        val.textContent = v;
        const name = document.createElement('span');
        name.textContent = label;
        row.append(key, val, name);
        tip.append(row);
      }
      const box = g.getBoundingClientRect();
      const host = wrap.getBoundingClientRect();
      tip.hidden = false;
      const left = Math.min(host.width - tip.offsetWidth - 4, Math.max(4, box.left - host.left + box.width / 2 - tip.offsetWidth / 2));
      tip.style.left = `${left}px`;
      tip.style.top = '4px';
    };
    const hide = () => {
      tip.hidden = true;
      wrap.querySelectorAll('.col.on').forEach((x) => {
        x.classList.remove('on');
      });
    };
    svg.querySelectorAll('.col').forEach((g) => {
      g.addEventListener('pointerenter', () => show(g));
      g.addEventListener('focus', () => show(g));
      g.addEventListener('blur', hide);
    });
    svg.addEventListener('pointerleave', hide);
  });
})();
