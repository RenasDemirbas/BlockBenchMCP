// Shared page behaviour: copy buttons on code blocks, the mobile menu, gentle reveal on scroll.
document.documentElement.classList.add('js');

for (const pre of document.querySelectorAll('pre')) {
  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    const text = pre.querySelector('code')?.innerText ?? pre.innerText;
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ''));
      button.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      button.textContent = 'Selected';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  });
  pre.append(button);
}

const menu = document.querySelector('.menu-btn');
menu?.addEventListener('click', () => {
  const open = !document.querySelector('.topnav').classList.toggle('open');
  document.querySelector('.sidebar')?.classList.toggle('open', !open);
  menu.setAttribute('aria-expanded', String(!open));
});

const reveal = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  reveal.forEach((el) => io.observe(el));
} else {
  reveal.forEach((el) => el.classList.add('seen'));
}
