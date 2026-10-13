// Sidebar navigation. Pages get real content as the WPF SettingsWindow is ported.
const titles: Record<string, string> = {
  dictation: 'Диктовка',
  file: 'Расшифровка файла',
  brain: 'Мозг',
  network: 'Сеть',
};

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav button'))) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const h = document.querySelector('#page h1');
    if (h) h.textContent = titles[btn.dataset.page ?? ''] ?? '';
  });
}
