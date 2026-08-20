(() => {
  const button = document.getElementById('vovkaHelperButton');
  const panel = document.getElementById('vovkaHelperPanel');
  const close = document.getElementById('closeVovkaButton');
  const answer = document.getElementById('vovkaHelperAnswer');
  const speak = document.getElementById('vovkaSpeakButton');
  if (!button || !panel || !answer) return;

  const answers = {
    start: { text: 'Начнём с главного: откройте вкладку «Сводка». Там собраны основные суммы и важные подсказки по классу.', view: 'summary' },
    child: { text: 'Ищем ваш личный взнос: откройте «Взносы», затем найдите блок «Мой взнос» и выберите своего ребёнка.', view: 'contributions' },
    contribution: { text: 'Откройте «Взносы». В блоке «Мой взнос» можно выбрать ребёнка и посмотреть нужный сбор.', view: 'contributions' },
    chat: { text: 'Чтобы написать родителям, нажмите зелёную кнопку «Чат класса». Вовка рядом, если нужно подсказать дорогу по сайту.', view: null },
    expenses: { text: 'Откройте вкладку «Расходы». Там можно посмотреть, на что были потрачены деньги класса.', view: 'expenses' },
  };
  let currentText = '';

  const setOpen = (open) => {
    panel.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    button.setAttribute('aria-expanded', String(open));
    if (!open && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    if (open) panel.querySelector('[data-vovka-question]')?.focus();
  };

  const speakCurrentAnswer = () => {
    if (!currentText || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(currentText);
    utterance.lang = 'ru-RU';
    utterance.rate = 0.95;
    utterance.pitch = 1.05;
    const russianVoice = window.speechSynthesis.getVoices().find((voice) => /^ru(-|_|$)/i.test(voice.lang));
    if (russianVoice) utterance.voice = russianVoice;
    window.speechSynthesis.speak(utterance);
  };

  button.addEventListener('click', () => setOpen(!panel.classList.contains('is-open')));
  close?.addEventListener('click', () => { setOpen(false); button.focus(); });
  speak?.addEventListener('click', speakCurrentAnswer);
  panel.addEventListener('click', (event) => {
    const question = event.target.closest('[data-vovka-question]');
    if (!question) return;
    const item = answers[question.dataset.vovkaQuestion];
    if (!item) return;
    currentText = item.text;
    answer.textContent = currentText;
    if (speak) speak.disabled = !('speechSynthesis' in window);
    if (item.view) {
      const target = document.querySelector(`.nav-button[data-view="${item.view}"]`);
      if (target) target.click();
      else document.getElementById(`view-${item.view}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('is-open')) { setOpen(false); button.focus(); }
  });
})();
