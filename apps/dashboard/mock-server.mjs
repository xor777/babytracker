#!/usr/bin/env node
/**
 * Мок сервера BabyTracker для разработки дашборда.
 * Реализует docs/CONTRACT.md §3 (кроме LLM-воркера) на чистом node, без зависимостей.
 *
 *   node mock-server.mjs                 → http://localhost:8787
 *   PORT=9000 node mock-server.mjs
 *   MOCK_TOGGLE_SEC=20 node mock-server.mjs   → чаще переключает сон/бодрствование
 *
 * Если рядом лежит ./dist — отдаёт его статикой, как это будет делать настоящий сервер.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8787);
const CHILD_NAME = process.env.CHILD_NAME ?? 'Андрей';
const CHILD_BIRTHDATE = process.env.CHILD_BIRTHDATE ?? '2026-03-01';
const TOGGLE_MIN_SEC = Number(process.env.MOCK_TOGGLE_SEC ?? 45);
/** MOCK_NO_CLAUDE=1 — воркер без LLM: фразы уходят в skipped, /healthz это сообщает. */
const NO_CLAUDE = process.env.MOCK_NO_CLAUDE === '1';
/** MOCK_OPEN_FEED=fresh|stale — незакрытое кормление: идёт прямо сейчас или забыто. */
const OPEN_FEED = process.env.MOCK_OPEN_FEED ?? '';
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ данные

let eventSeq = 0;
let utteranceSeq = 0;
/** @type {Array<Record<string, any>>} */
const events = [];
/** @type {Array<Record<string, any>>} */
const utterances = [];

const iso = (ms) => new Date(ms).toISOString();
const rand = (a, b) => a + Math.random() * (b - a);

function localMidnight(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function makeEvent(type, subtype, startMs, endMs, valueNum, valueUnit, note) {
  return {
    id: ++eventSeq,
    child_id: 'andrey',
    type,
    subtype,
    started_at: iso(startMs),
    ended_at: endMs == null ? null : iso(endMs),
    value_num: valueNum ?? null,
    value_unit: valueUnit ?? null,
    note: note ?? null,
    source: 'alice-fast',
    utterance_id: null,
    confidence: 0.95,
    created_at: iso(startMs),
    updated_at: iso(startMs),
    deleted_at: null,
  };
}

function addSleep(startMs, durMin, subtype) {
  const end = startMs + durMin * MINUTE;
  if (startMs > Date.now()) return null;
  const ev = {
    id: ++eventSeq,
    child_id: 'andrey',
    type: 'sleep',
    subtype,
    started_at: iso(startMs),
    ended_at: end > Date.now() ? null : iso(end),
    value_num: null,
    value_unit: null,
    note: null,
    source: 'alice-fast',
    utterance_id: null,
    confidence: 0.95,
    created_at: iso(startMs),
    updated_at: iso(Math.min(end, Date.now())),
    deleted_at: null,
  };
  events.push(ev);
  return ev;
}

/** Правдоподобная история: ночь + три дневных сна, с разбросом. */
function seed() {
  for (let daysAgo = 14; daysAgo >= 0; daysAgo--) {
    const midnight = localMidnight(daysAgo);
    // «качество суток» — чтобы столбцы 14-дневного графика заметно отличались
    const mood = rand(0.72, 1.2);
    addSleep(midnight + 21.6 * HOUR + rand(-50, 50) * MINUTE, rand(150, 280) * mood, 'night');
    addSleep(midnight + 2.5 * HOUR + rand(-40, 40) * MINUTE, rand(90, 235) * mood, 'night');
    addSleep(midnight + 9.4 * HOUR + rand(-40, 40) * MINUTE, rand(40, 95) * mood, 'nap');
    if (Math.random() > 0.15) {
      addSleep(midnight + 13.1 * HOUR + rand(-40, 40) * MINUTE, rand(55, 125) * mood, 'nap');
    }
    if (Math.random() > 0.35) {
      addSleep(midnight + 16.7 * HOUR + rand(-40, 40) * MINUTE, rand(25, 70) * mood, 'nap');
    }
  }
  // Кормления и подгузники (контракт §10.1: 8–12 кормлений и 6+ мокрых в сутки).
  for (let daysAgo = 14; daysAgo >= 0; daysAgo--) {
    const midnight = localMidnight(daysAgo);
    const feeds = Math.round(rand(8, 11));
    for (let i = 0; i < feeds; i++) {
      const at = midnight + ((i + 0.5) * 24 * HOUR) / feeds + rand(-35, 35) * MINUTE;
      if (at > Date.now()) continue;
      // Объём есть только у бутылочки; грудь — длительность (§10.2).
      if (Math.random() < 0.55) {
        events.push(makeEvent('feed', 'bottle', at, at, Math.round(rand(60, 140)), 'ml'));
      } else {
        const min = Math.round(rand(10, 25));
        events.push(makeEvent('feed', 'breast', at, at + min * MINUTE, min, 'min', 'left'));
      }
    }
    const diapers = Math.round(rand(5, 9));
    for (let i = 0; i < diapers; i++) {
      const at = midnight + ((i + 0.5) * 24 * HOUR) / diapers + rand(-40, 40) * MINUTE;
      if (at > Date.now()) continue;
      const r = Math.random();
      events.push(makeEvent('diaper', r < 0.55 ? 'wet' : r < 0.85 ? 'dirty' : 'both', at, at));
    }
  }

  // Взвешивания: вес при рождении как точка отсчёта, дальше редкие замеры.
  const birth = localMidnight(14) + 9 * HOUR;
  events.push(makeEvent('measure', 'weight', birth, birth, 4620, 'g', 'вес при рождении'));
  [10, 6, 2].forEach((daysAgo, i) => {
    const at = localMidnight(daysAgo) + 9 * HOUR;
    if (at > Date.now()) return;
    events.push(makeEvent('measure', 'weight', at, at, [4480, 4590, 4760][i], 'g'));
  });

  if (OPEN_FEED) {
    // «начал кушать» сказали, «поел» — нет. fresh: идёт; stale: фразу забыли.
    const startedAgoMin = OPEN_FEED === 'stale' ? 190 : 9;
    const at = Date.now() - startedAgoMin * MINUTE;
    events.push({ ...makeEvent('feed', 'breast', at, null, null, null, 'left') });
  }

  events.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  // Инвариант контракта §1: открытый сон может быть только один — последний.
  const sleeps = events.filter((e) => e.type === 'sleep');
  for (const ev of sleeps.slice(0, -1)) {
    if (!ev.ended_at) ev.ended_at = iso(Date.parse(ev.started_at) + 60 * MINUTE);
  }
  // Случайный разброс иногда накладывал сны друг на друга — выкидываем такие,
  // чтобы тестовые данные не были заведомо противоречивыми.
  let prevEnd = 0;
  for (const ev of sleeps) {
    const start = Date.parse(ev.started_at);
    if (start < prevEnd) {
      ev.deleted_at = iso(start);
      continue;
    }
    prevEnd = ev.ended_at ? Date.parse(ev.ended_at) : Infinity;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].deleted_at) events.splice(i, 1);
  }

  const phrases = [
    'андрей заснул',
    'проснулся',
    'уложили в кроватку',
    'кажется опять уснул',
    'андрей проснулся полчаса назад',
    'сколько он сегодня спал',
  ];
  phrases.forEach((raw, i) => {
    // Смесь статусов как на бою: уверенный fast-path → skipped (модель не звали),
    // вопрос → skipped с kind=query_state, остальное → done после модели.
    const kind = raw.includes('сколько') ? 'query_state' : i % 2 ? 'sleep_end' : 'sleep_start';
    const skipped = kind !== 'sleep_end' || i % 4 === 1;
    utterances.push({
      id: ++utteranceSeq,
      raw_text: raw,
      alice_user_id: 'mock-user',
      session_id: 'mock',
      received_at: iso(Date.now() - (phrases.length - i) * 17 * MINUTE),
      status: skipped ? 'skipped' : 'done',
      // Наружу сервер отдаёт разобранный объект, а не JSON-строку.
      fast_result: { kind, confidence: 0.95 },
      llm_result: skipped ? null : { kind, confidence: 0.82 },
      llm_error: skipped
        ? `не отправлено модели: fast-path уверенно разобрал как ${kind} (0.95 >= 0.8)`
        : null,
      attempts: skipped ? 0 : 1,
      processed_at: iso(Date.now() - (phrases.length - i) * 17 * MINUTE + 1200),
    });
  });
  utterances.reverse();
}

const openSleep = () => events.find((e) => e.type === 'sleep' && !e.ended_at && !e.deleted_at);

function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sleepMinutesOn(dateStr) {
  let total = 0;
  let sessions = 0;
  let longest = 0;
  for (const ev of events) {
    if (ev.type !== 'sleep' || ev.deleted_at) continue;
    if (localDateStr(Date.parse(ev.started_at)) !== dateStr) continue;
    const end = ev.ended_at ? Date.parse(ev.ended_at) : Date.now();
    const min = Math.max(0, Math.round((end - Date.parse(ev.started_at)) / MINUTE));
    total += min;
    sessions += 1;
    longest = Math.max(longest, min);
  }
  return { total, sessions, longest };
}

function buildState() {
  const now = Date.now();
  const open = openSleep();
  const closed = events.filter((e) => e.type === 'sleep' && e.ended_at && !e.deleted_at);
  const last = closed[closed.length - 1] ?? null;
  const since = open ? Date.parse(open.started_at) : last ? Date.parse(last.ended_at) : now;
  const today = sleepMinutesOn(localDateStr(now));
  const pending = utterances.filter((u) => u.status === 'pending' || u.status === 'processing').length;

  return {
    now: iso(now),
    child: {
      name: CHILD_NAME,
      birthDate: CHILD_BIRTHDATE,
      ageDays: Math.floor((now - Date.parse(`${CHILD_BIRTHDATE}T00:00:00`)) / DAY),
    },
    sleep: {
      status: open ? 'asleep' : 'awake',
      since: iso(since),
      currentDurationMin: Math.round((now - since) / MINUTE),
      lastSleep: last
        ? {
            startedAt: last.started_at,
            endedAt: last.ended_at,
            durationMin: Math.round((Date.parse(last.ended_at) - Date.parse(last.started_at)) / MINUTE),
          }
        : null,
    },
    today: {
      date: localDateStr(now),
      sleepTotalMin: today.total,
      sleepSessions: today.sessions,
      longestSleepMin: today.longest,
    },
    pending,
  };
}

function buildDaily(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = localDateStr(localMidnight(i));
    const agg = sleepMinutesOn(date);
    let nightMin = 0;
    for (const ev of events) {
      if (ev.type !== 'sleep' || ev.deleted_at || ev.subtype !== 'night') continue;
      if (localDateStr(Date.parse(ev.started_at)) !== date) continue;
      const end = ev.ended_at ? Date.parse(ev.ended_at) : Date.now();
      nightMin += Math.max(0, Math.round((end - Date.parse(ev.started_at)) / MINUTE));
    }
    out.push({
      date,
      totalMin: agg.total,
      sessions: agg.sessions,
      nightMin,
      napMin: agg.total - nightMin,
    });
  }
  return out;
}

// ------------------------------------------------------------------ SSE

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}

// ------------------------------------------------------------------ симуляция

const SLEEP_PHRASES = ['андрей заснул', 'уложили спать', 'вроде уснул', 'спатки пошёл'];
const WAKE_PHRASES = ['проснулся', 'андрей проснулся', 'глаза открыл', 'не спит уже'];
const NOISE_PHRASES = [
  'сколько он сегодня спал',
  'что там по сну',
  'кажется он покушал',
  'дай отчёт',
  'андрей перевернулся на живот',
];

function pushUtterance(raw, kind) {
  const u = {
    id: ++utteranceSeq,
    raw_text: raw,
    alice_user_id: 'mock-user',
    session_id: 'mock',
    received_at: iso(Date.now()),
    status: 'pending',
    fast_result: kind ? { kind, confidence: 0.92 } : null,
    llm_result: null,
    llm_error: null,
    attempts: 0,
    processed_at: null,
  };
  utterances.unshift(u);
  utterances.length = Math.min(utterances.length, 60);
  broadcast('utterance', {
    id: u.id,
    raw_text: u.raw_text,
    status: u.status,
    fast_result: u.fast_result,
    llm_result: u.llm_result,
  });
  broadcast('state', buildState());

  // Как настоящий сервер: если fast-path разобрал уверенно, модель не зовём —
  // фраза сразу уходит в skipped, и это успех, а не сбой.
  if (kind && !NO_CLAUDE) {
    setTimeout(() => {
      u.status = 'skipped';
      u.processed_at = iso(Date.now());
      u.llm_error = `не отправлено модели: fast-path уверенно разобрал как ${kind} (0.95 >= 0.8)`;
      broadcast('utterance', {
        id: u.id,
        raw_text: u.raw_text,
        status: u.status,
        fast_result: u.fast_result,
        llm_result: null,
      });
      broadcast('state', buildState());
    }, 900);
    return;
  }

  // Без claude воркер помечает skipped вообще всё, включая непонятое.
  if (NO_CLAUDE) {
    setTimeout(() => {
      u.status = 'skipped';
      u.processed_at = iso(Date.now());
      broadcast('utterance', {
        id: u.id,
        raw_text: u.raw_text,
        status: u.status,
        fast_result: u.fast_result,
        llm_result: null,
      });
      broadcast('state', buildState());
    }, 1500);
    return;
  }

  // pending → processing → done/failed, как это делает воркер
  setTimeout(() => {
    u.status = 'processing';
    broadcast('utterance', { id: u.id, raw_text: u.raw_text, status: u.status, fast_result: u.fast_result, llm_result: null });
    broadcast('state', buildState());
  }, 2500);

  setTimeout(() => {
    const failed = !kind && Math.random() < 0.25;
    u.status = failed ? 'failed' : 'done';
    u.processed_at = iso(Date.now());
    u.llm_result = failed ? null : { kind: kind ?? 'unknown', confidence: 0.8 };
    u.llm_error = failed ? 'timeout' : null;
    broadcast('utterance', {
      id: u.id,
      raw_text: u.raw_text,
      status: u.status,
      fast_result: u.fast_result,
      llm_result: u.llm_result,
    });
    broadcast('state', buildState());
  }, 6500);
}

let nextToggle = Date.now() + TOGGLE_MIN_SEC * 1000;
let nextNoise = Date.now() + 18_000;
let nextFeed = Date.now() + 25_000;

function tick() {
  const now = Date.now();

  if (now >= nextToggle) {
    const open = openSleep();
    if (!open && Math.random() < 0.15) {
      // «проснулся», когда сна не было: сервер пишет заметку. Дашборд не должен споткнуться.
      const note = {
        id: ++eventSeq,
        child_id: 'andrey',
        type: 'note',
        subtype: null,
        started_at: iso(now),
        ended_at: iso(now),
        value_num: null,
        value_unit: null,
        note: 'проснулся, хотя сон не был записан',
        source: 'alice-fast',
        utterance_id: null,
        confidence: 0.5,
        created_at: iso(now),
        updated_at: iso(now),
        deleted_at: null,
      };
      events.push(note);
      broadcast('event', { action: 'created', event: note });
      pushUtterance('а он и не спал', 'sleep_end');
      nextToggle = now + rand(10, 20) * 1000;
      return;
    }
    if (open) {
      open.ended_at = iso(now);
      open.updated_at = iso(now);
      broadcast('event', { action: 'updated', event: open });
      pushUtterance(WAKE_PHRASES[Math.floor(Math.random() * WAKE_PHRASES.length)], 'sleep_end');
    } else {
      const ev = {
        id: ++eventSeq,
        child_id: 'andrey',
        type: 'sleep',
        subtype: new Date().getHours() >= 20 || new Date().getHours() < 6 ? 'night' : 'nap',
        started_at: iso(now),
        ended_at: null,
        value_num: null,
        value_unit: null,
        note: null,
        source: 'alice-fast',
        utterance_id: null,
        confidence: 0.95,
        created_at: iso(now),
        updated_at: iso(now),
        deleted_at: null,
      };
      events.push(ev);
      broadcast('event', { action: 'created', event: ev });
      pushUtterance(SLEEP_PHRASES[Math.floor(Math.random() * SLEEP_PHRASES.length)], 'sleep_start');
    }
    nextToggle = now + rand(TOGGLE_MIN_SEC, TOGGLE_MIN_SEC * 2) * 1000;
  }

  if (now >= nextFeed) {
    const bottle = Math.random() < 0.6;
    // Грудь начинается открытым событием и закрывается отдельной фразой —
    // ровно как в жизни, где вторую фразу иногда забывают.
    const ev = bottle
      ? makeEvent('feed', 'bottle', now, now, Math.round(rand(60, 140)), 'ml')
      : makeEvent('feed', 'breast', now, null, null, null, 'left');
    events.push(ev);
    broadcast('event', { action: 'created', event: ev });
    if (!bottle) {
      setTimeout(() => {
        if (ev.ended_at) return;
        const end = Date.now();
        ev.ended_at = iso(end);
        ev.value_num = Math.max(1, Math.round((end - Date.parse(ev.started_at)) / MINUTE));
        ev.value_unit = 'min';
        ev.updated_at = iso(end);
        broadcast('event', { action: 'updated', event: ev });
        broadcast('state', buildState());
      }, rand(45, 100) * 1000);
    }
    pushUtterance(bottle ? `андрей поел ${ev.value_num} мл` : 'покормили грудью', null);
    nextFeed = now + rand(70, 150) * 1000;
  }

  if (now >= nextNoise) {
    pushUtterance(NOISE_PHRASES[Math.floor(Math.random() * NOISE_PHRASES.length)], null);
    nextNoise = now + rand(20, 45) * 1000;
  }
}

// ------------------------------------------------------------------ http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  if (!fs.existsSync(DIST)) return false;
  const rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (pathname === '/healthz') {
    return sendJson(res, {
      ok: true,
      db: true,
      worker: {
        alive: true,
        lastRunAt: iso(Date.now()),
        queueDepth: buildState().pending,
        claudeAvailable: !NO_CLAUDE,
        claudeProblem: NO_CLAUDE ? 'claude cli не найден' : null,
      },
    });
  }

  if (pathname === '/api/state') return sendJson(res, buildState());

  if (pathname === '/api/sleep/daily') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 14)));
    return sendJson(res, { days: buildDaily(days) });
  }

  if (pathname === '/api/utterances') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    return sendJson(res, { utterances: utterances.slice(0, limit) });
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const type = url.searchParams.get('type');
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const list = events
      .filter((e) => !e.deleted_at)
      .filter((e) => (type ? e.type === type : true))
      .filter((e) => {
        const end = e.ended_at ? Date.parse(e.ended_at) : Date.now();
        return end >= fromMs && Date.parse(e.started_at) <= toMs;
      })
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .slice(0, limit);
    return sendJson(res, { events: list });
  }

  if (pathname === '/api/events' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, { error: 'bad json' }, 400);
      }
      const ev = {
        id: ++eventSeq,
        child_id: 'andrey',
        type: payload.type ?? 'note',
        subtype: payload.subtype ?? null,
        started_at: payload.started_at ?? iso(Date.now()),
        ended_at: payload.ended_at ?? null,
        value_num: payload.value_num ?? null,
        value_unit: payload.value_unit ?? null,
        note: payload.note ?? null,
        source: 'manual',
        utterance_id: null,
        confidence: payload.confidence ?? null,
        created_at: iso(Date.now()),
        updated_at: iso(Date.now()),
        deleted_at: null,
      };
      events.push(ev);
      broadcast('event', { action: 'created', event: ev });
      broadcast('state', buildState());
      sendJson(res, { event: ev }, 201);
    });
    return undefined;
  }

  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
    clients.add(res);
    console.log(`[sse] клиент подключился, всего ${clients.size}`);
    req.on('close', () => {
      clients.delete(res);
      console.log(`[sse] клиент отключился, осталось ${clients.size}`);
    });
    return undefined;
  }

  if (pathname.startsWith('/alice/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let command = '';
      try {
        command = JSON.parse(body || '{}')?.request?.command ?? '';
      } catch {
        /* ignore */
      }
      if (command) pushUtterance(command, /засн|усн|спат/.test(command) ? 'sleep_start' : null);
      sendJson(res, {
        response: { text: `Записала: «${command}»`, tts: 'Записала', end_session: false },
        version: '1.0',
      });
    });
    return undefined;
  }

  if (req.method === 'GET' && serveStatic(res, pathname)) return undefined;

  return sendJson(res, { error: 'not found' }, 404);
});

seed();
setInterval(tick, 1000);
// Сердцебиение: без него Cloudflare Tunnel рвёт SSE (контракт §3.6).
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15_000);
// Периодический state — как у настоящего сервера, чтобы таймеры не расходились.
setInterval(() => broadcast('state', buildState()), 10_000);

server.listen(PORT, () => {
  console.log(`[mock] BabyTracker слушает http://localhost:${PORT}`);
  console.log(`[mock] сон переключается каждые ~${TOGGLE_MIN_SEC}–${TOGGLE_MIN_SEC * 2} с`);
  if (fs.existsSync(DIST)) console.log('[mock] отдаю ./dist статикой');
});
