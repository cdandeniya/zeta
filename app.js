(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const screens = { settings: $('#settings'), game: $('#game'), end: $('#end') };
  const form = $('#settings-form');
  const answerEl = $('#answer');
  const problemEl = $('#problem');
  const timerEl = $('#timer');
  const scoreEl = $('#score');

  const SETTINGS_KEY = 'zeta:settings';
  const HIGH_KEY_PREFIX = 'zeta:high:';

  let config = null;      // settings for the current game
  let current = null;     // { text, answer }
  let score = 0;
  let endsAt = 0;
  let tickId = null;
  let endShownAt = 0;

  // ---------- helpers ----------
  const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch { /* ignore */ } },
  };

  function show(name) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  }

  // ---------- settings ----------
  function readSettings() {
    const f = form.elements;
    const num = (name) => Number(f[name].value);
    const durationChoice = form.querySelector('input[name="duration"]:checked').value;
    const duration = durationChoice === 'custom' ? num('customSeconds') : Number(durationChoice);
    return {
      ops: { add: f.add.checked, sub: f.sub.checked, mul: f.mul.checked, div: f.div.checked },
      add: [num('addA1'), num('addA2'), num('addB1'), num('addB2')],
      mul: [num('mulA1'), num('mulA2'), num('mulB1'), num('mulB2')],
      duration,
      durationChoice,
    };
  }

  function validate(s) {
    const { ops } = s;
    if (!ops.add && !ops.sub && !ops.mul && !ops.div) return 'pick at least one operation.';
    if (!Number.isInteger(s.duration) || s.duration < 1 || s.duration > 3600) {
      return 'duration must be a whole number of seconds (1–3600).';
    }
    const checkRanges = (vals, label) => {
      if (!vals.every((v) => Number.isInteger(v) && v >= 0 && v <= 100000)) {
        return `${label} ranges must be whole numbers from 0 to 100000.`;
      }
      if (vals[0] > vals[1] || vals[2] > vals[3]) return `${label} ranges: min must not exceed max.`;
      return null;
    };
    if (ops.add || ops.sub) {
      const err = checkRanges(s.add, 'addition');
      if (err) return err;
    }
    if (ops.mul || ops.div) {
      const err = checkRanges(s.mul, 'multiplication');
      if (err) return err;
      if (ops.div && s.mul[1] === 0) return 'division needs a non-zero divisor (first multiplication range).';
    }
    return null;
  }

  // High scores are keyed by everything that affects difficulty.
  function highKey(s) {
    const ops = ['add', 'sub', 'mul', 'div'].filter((k) => s.ops[k]);
    const parts = [ops.join('+'), `t${s.duration}`];
    if (s.ops.add || s.ops.sub) parts.push(`a${s.add.join(',')}`);
    if (s.ops.mul || s.ops.div) parts.push(`m${s.mul.join(',')}`);
    return HIGH_KEY_PREFIX + parts.join('|');
  }

  function getHigh(s) {
    const v = Number(storage.get(highKey(s)));
    return Number.isFinite(v) ? v : 0;
  }

  function saveSettings(s) { storage.set(SETTINGS_KEY, JSON.stringify(s)); }

  function loadSettings() {
    let s;
    try { s = JSON.parse(storage.get(SETTINGS_KEY)); } catch { s = null; }
    if (!s || typeof s !== 'object') return;
    const f = form.elements;
    try {
      for (const k of ['add', 'sub', 'mul', 'div']) f[k].checked = !!s.ops[k];
      ['addA1', 'addA2', 'addB1', 'addB2'].forEach((n, i) => { f[n].value = s.add[i]; });
      ['mulA1', 'mulA2', 'mulB1', 'mulB2'].forEach((n, i) => { f[n].value = s.mul[i]; });
      const radio = form.querySelector(`input[name="duration"][value="${s.durationChoice}"]`);
      if (radio) radio.checked = true;
      if (s.durationChoice === 'custom') f.customSeconds.value = s.duration;
    } catch { /* ignore malformed saved settings */ }
  }

  function refreshSettingsUI() {
    const f = form.elements;
    const custom = form.querySelector('input[name="duration"]:checked').value === 'custom';
    f.customSeconds.disabled = !custom;
    // dim range inputs for unused operations
    const addRange = f.addA1.closest('.range');
    const mulRange = f.mulA1.closest('.range');
    addRange.classList.toggle('disabled', !(f.add.checked || f.sub.checked));
    mulRange.classList.toggle('disabled', !(f.mul.checked || f.div.checked));
    f.sub.closest('.op').nextElementSibling.classList.toggle('disabled', !f.sub.checked);
    f.div.closest('.op').nextElementSibling.classList.toggle('disabled', !f.div.checked);

    const s = readSettings();
    const err = validate(s);
    $('#settings-error').textContent = '';
    $('#settings-best').textContent = err ? '' : `best for these settings: ${getHigh(s)}`;
  }

  // ---------- problems ----------
  function makeProblem(s) {
    const ops = ['add', 'sub', 'mul', 'div'].filter((k) => s.ops[k]);
    const op = ops[randInt(0, ops.length - 1)];
    const [a1, a2, b1, b2] = op === 'add' || op === 'sub' ? s.add : s.mul;
    let a = randInt(a1, a2);
    const b = randInt(b1, b2);
    switch (op) {
      case 'add': return { text: `${a} + ${b}`, answer: a + b };
      // subtraction is addition reversed: (a + b) − a = b ≥ 0
      case 'sub': return { text: `${a + b} − ${a}`, answer: b };
      case 'mul': return { text: `${a} × ${b}`, answer: a * b };
      // division is multiplication reversed: (a × b) ÷ a = b, divisor never 0
      case 'div':
        while (a === 0) a = randInt(Math.max(a1, 1), a2);
        return { text: `${a * b} ÷ ${a}`, answer: b };
    }
    return null;
  }

  function nextProblem() {
    let p;
    // avoid showing the exact same problem twice in a row when possible
    for (let i = 0; i < 5; i++) {
      p = makeProblem(config);
      if (!current || p.text !== current.text) break;
    }
    current = p;
    problemEl.textContent = p.text;
    answerEl.value = '';
    sizeAnswer();
  }

  function sizeAnswer() {
    const len = Math.max(String(current ? current.answer : '').length, answerEl.value.length, 3);
    answerEl.style.width = `${len + 0.5}ch`;
  }

  // ---------- game flow ----------
  function startGame() {
    const s = readSettings();
    const err = validate(s);
    if (err) {
      show('settings');
      $('#settings-error').textContent = err;
      return;
    }
    saveSettings(s);
    config = s;
    score = 0;
    current = null;
    scoreEl.textContent = '0';
    endsAt = Date.now() + s.duration * 1000;
    timerEl.textContent = String(s.duration);
    show('game');
    nextProblem();
    answerEl.focus();
    clearInterval(tickId);
    tickId = setInterval(tick, 100);
  }

  function tick() {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    timerEl.textContent = String(left);
    if (left <= 0) endGame();
  }

  function endGame() {
    clearInterval(tickId);
    tickId = null;
    answerEl.blur();

    const prev = getHigh(config);
    const isNew = score > prev;
    if (isNew) storage.set(highKey(config), String(score));

    $('#final-score').textContent = String(score);
    const perMin = score / (config.duration / 60);
    $('#rate').textContent = `${perMin.toFixed(1)} problems / minute · ${config.duration}s`;
    $('#highscore').textContent = isNew
      ? (prev > 0 ? `new high score (previous ${prev})` : 'new high score')
      : `high score: ${prev}`;
    endShownAt = Date.now();
    show('end');
    $('#again-btn').focus();
  }

  function quitToSettings() {
    clearInterval(tickId);
    tickId = null;
    show('settings');
    refreshSettingsUI();
    $('#start-btn').focus();
  }

  // ---------- events ----------
  form.addEventListener('submit', (e) => { e.preventDefault(); startGame(); });
  form.addEventListener('input', refreshSettingsUI);
  form.addEventListener('change', refreshSettingsUI);
  form.querySelectorAll('input[name="duration"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.value === 'custom' && r.checked) form.elements.customSeconds.focus();
    });
  });

  answerEl.addEventListener('input', () => {
    // keep digits and a leading minus only
    const cleaned = answerEl.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '');
    if (cleaned !== answerEl.value) answerEl.value = cleaned;
    sizeAnswer();
    if (tickId && current && cleaned !== '' && cleaned !== '-' && Number(cleaned) === current.answer) {
      score += 1;
      scoreEl.textContent = String(score);
      nextProblem();
    }
  });

  // keep focus on the answer box during a game
  answerEl.addEventListener('blur', () => {
    if (tickId) setTimeout(() => { if (tickId) answerEl.focus(); }, 0);
  });
  screens.game.addEventListener('mousedown', (e) => {
    if (e.target !== answerEl) { e.preventDefault(); answerEl.focus(); }
  });

  $('#again-btn').addEventListener('click', startGame);
  $('#back-btn').addEventListener('click', quitToSettings);

  document.addEventListener('keydown', (e) => {
    if (!screens.game.hidden && e.key === 'Escape') {
      e.preventDefault();
      quitToSettings();
    } else if (!screens.end.hidden && e.key === 'Enter' && document.activeElement !== $('#back-btn')) {
      e.preventDefault();
      // brief guard so a keypress in flight at time-up doesn't skip the results
      if (Date.now() - endShownAt > 400) startGame();
    }
  });

  window.addEventListener('focus', () => { if (tickId) answerEl.focus(); });

  loadSettings();
  refreshSettingsUI();
  $('#start-btn').focus();
})();
