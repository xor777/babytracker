/** §3.1: вебхук Алисы — доступ, тексты ответов, бюджет 200 мс. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_SECRET, aliceBody, makeTestApp } from './helpers.ts';
import { secretsEqual, ACK } from '../src/alice.ts';
import { maskUrl } from '../src/app.ts';
import { queryEvents } from '../src/events.ts';
import { createApp } from '../src/app.ts';
import { testConfig, testDb } from './helpers.ts';
import { listUtterances } from '../src/utterances.ts';

const URL_OK = `/alice/${TEST_SECRET}`;

async function post(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  url: string,
  payload: unknown,
) {
  return app.inject({ method: 'POST', url, payload: payload as object });
}

test('неверный секрет отклонён нейтральным ответом, событий не создаётся', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, '/alice/ffffffffffffffffffffffffffffffff', aliceBody('андрей заснул'));

  assert.equal(res.statusCode, 200, 'Алисе всегда 200, иначе она покажет ошибку');
  const body = res.json() as { response: { text: string; end_session: boolean }; version: string };
  assert.equal(body.version, '1.0');
  assert.ok(body.response.text.length > 0);
  assert.ok(!body.response.text.includes('заснул'), 'нейтральный текст не раскрывает причину');
  assert.equal(queryEvents(h.db, {}).length, 0, 'чужой запрос ничего не записал');
});

test('секрет неверной длины тоже отклонён', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const bad of ['', 'short', `${TEST_SECRET}extra`, TEST_SECRET.slice(0, 31)]) {
    const res = await post(h.app, `/alice/${bad}`, aliceBody('андрей заснул'));
    assert.equal(res.statusCode, 200);
  }
  assert.equal(queryEvents(h.db, {}).length, 0);
});

test('сравнение секретов не зависит от длины и не бросает', () => {
  assert.equal(secretsEqual(TEST_SECRET, TEST_SECRET), true);
  assert.equal(secretsEqual(TEST_SECRET, 'x'), false);
  assert.equal(secretsEqual('', ''), true);
  assert.equal(secretsEqual(TEST_SECRET, ''), false);
});

test('чужой skill_id отклонён', async (t) => {
  const h = await makeTestApp({ ALICE_SKILL_ID: 'my-skill' });
  t.after(() => h.close());

  const alien = await post(h.app, URL_OK, aliceBody('андрей заснул', { skillId: 'other-skill' }));
  assert.equal(alien.statusCode, 200);
  assert.equal(queryEvents(h.db, {}).length, 0, 'чужой навык ничего не записал');

  const own = await post(h.app, URL_OK, aliceBody('андрей заснул', { skillId: 'my-skill' }));
  assert.equal(own.statusCode, 200);
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1);
});

test('чужой user_id отклонён, свой принят', async (t) => {
  const h = await makeTestApp({ ALICE_ALLOWED_USER_IDS: 'user-a, user-b' });
  t.after(() => h.close());

  await post(h.app, URL_OK, aliceBody('андрей заснул', { userId: 'user-zzz' }));
  assert.equal(queryEvents(h.db, {}).length, 0);

  await post(h.app, URL_OK, aliceBody('андрей заснул', { userId: 'user-b' }));
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1);
});

test('приветствие на новой сессии с пустой командой, сессия не закрывается', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('', { isNew: true }));
  const body = res.json() as { response: { text: string; tts: string; end_session: boolean } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.response.end_session, false);
  assert.match(body.response.text, /Андрей/);
  assert.equal(listUtterances(h.db).length, 0, 'приветствие не засоряет очередь');
});

test('полный сценарий: заснул -> проснулся -> сводка', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const started = await post(h.app, URL_OK, aliceBody('андрей заснул'));
  const startedBody = started.json() as { response: { text: string; end_session: boolean } };
  assert.equal(startedBody.response.text, ACK);
  assert.equal(startedBody.response.end_session, false);

  // повторное «заснул» не создаёт второй открытый сон
  const again = await post(h.app, URL_OK, aliceBody('андрей заснул'));
  const againBody = again.json() as { response: { text: string } };
  // Голос одинаков и на первое «заснул», и на повторное: вслух подтверждаем
  // только приём. Что второго сна не завелось — видно по базе, не по реплике.
  assert.equal(againBody.response.text, ACK);
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1);

  const woke = await post(h.app, URL_OK, aliceBody('андрей проснулся'));
  const wokeBody = woke.json() as { response: { text: string } };
  assert.equal(wokeBody.response.text, ACK);

  const summary = await post(h.app, URL_OK, aliceBody('сколько он сегодня спал'));
  const summaryBody = summary.json() as { response: { text: string } };
  assert.match(summaryBody.response.text, /Сегодня всего/);
});

test('«проснулся» без открытого сна отвечает и не падает', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('андрей проснулся'));
  const body = res.json() as { response: { text: string } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.response.text, ACK);
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 0);
  assert.equal(queryEvents(h.db, { type: 'note' }).length, 1);
});

test('мусорная фраза принимается и уходит в очередь на разбор', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('абырвалг колбаса'));
  const body = res.json() as { response: { text: string; end_session: boolean } };

  assert.equal(body.response.text, ACK);
  assert.equal(body.response.end_session, false);

  const queue = listUtterances(h.db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.status, 'pending');
  assert.equal(queue[0]?.raw_text, 'абырвалг колбаса');
});

test('команда выхода закрывает сессию и не идёт в LLM', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('хватит'));
  const body = res.json() as { response: { text: string; end_session: boolean } };

  assert.equal(body.response.end_session, true);
  assert.equal(listUtterances(h.db)[0]?.status, 'skipped');
});

test('ответ укладывается в бюджет 200 мс', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // прогрев: первый вызов включает разбор роутов и JIT
  await post(h.app, URL_OK, aliceBody('андрей заснул'));

  const samples: number[] = [];
  const phrases = ['андрей проснулся', 'андрей заснул', 'сколько он спал', 'абырвалг', 'встал'];
  for (const phrase of phrases) {
    const t0 = process.hrtime.bigint();
    const res = await post(h.app, URL_OK, aliceBody(phrase));
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(res.statusCode, 200);
    samples.push(elapsedMs);
  }

  const worst = Math.max(...samples);
  assert.ok(worst < 200, `худший ответ ${worst.toFixed(1)} мс, бюджет 200 мс`);
});

test('text и tts не длиннее 1024 символов', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('я'.repeat(5000)));
  const body = res.json() as { response: { text: string; tts: string } };

  assert.ok(body.response.text.length <= 1024, `text: ${body.response.text.length}`);
  assert.ok(body.response.tts.length <= 1024, `tts: ${body.response.tts.length}`);
});

test('битое тело запроса не роняет вебхук', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const payload of [{}, { session: null }, { request: { command: null } }, []]) {
    const res = await post(h.app, URL_OK, payload);
    assert.equal(res.statusCode, 200, `payload: ${JSON.stringify(payload)}`);
    assert.equal((res.json() as { version: string }).version, '1.0');
  }

  const broken = await h.app.inject({
    method: 'POST',
    url: URL_OK,
    headers: { 'content-type': 'application/json' },
    payload: '{ не json',
  });
  assert.equal(broken.statusCode, 200, 'даже сломанный JSON получает 200 с нейтральным текстом');
});

test('секрет вебхука маскируется в логах', () => {
  assert.equal(maskUrl(`/alice/${TEST_SECRET}`), '/alice/***');
  assert.equal(maskUrl(`/alice/${TEST_SECRET}?x=1`), '/alice/***?x=1');
  assert.equal(maskUrl('/api/state'), '/api/state');
});


/* ------------------------------------------------------------------ */
/* Опознание владельца: аккаунт, а не устройство                        */
/*                                                                      */
/* Прод-инцидент: белый список читал session.user_id — устаревшее поле, */
/* идентифицирующее ЭКЗЕМПЛЯР ПРИЛОЖЕНИЯ. Консоль, телефон и каждая     */
/* колонка дают разные значения, поэтому заказчика заперло трижды.      */
/* ------------------------------------------------------------------ */

interface IdentityFields {
  accountId?: string | null;
  applicationId?: string;
  legacyUserId?: string;
  skillId?: string;
  command?: string;
  isNew?: boolean;
}

/** Тело запроса с раздельным управлением всеми тремя полями идентичности. */
function bodyWith(fields: IdentityFields): Record<string, unknown> {
  const session: Record<string, unknown> = {
    message_id: 0,
    session_id: 'sess',
    skill_id: fields.skillId ?? 'skill-1',
    new: fields.isNew ?? false,
    // устаревшее поле приходит всегда
    user_id: fields.legacyUserId ?? fields.applicationId ?? 'app-1',
    application: { application_id: fields.applicationId ?? 'app-1' },
  };
  // объекта user нет, если пользователь не авторизован
  if (fields.accountId) session.user = { user_id: fields.accountId };

  return {
    meta: { locale: 'ru-RU', timezone: 'Europe/Moscow', interfaces: {} },
    session,
    request: {
      type: 'SimpleUtterance',
      command: fields.command ?? 'андрей заснул',
      nlu: { tokens: [], entities: [], intents: {} },
    },
    version: '1.0',
  };
}

const say = (app: Awaited<ReturnType<typeof makeTestApp>>['app'], fields: IdentityFields) =>
  app.inject({ method: 'POST', url: URL_OK, payload: bodyWith(fields) });

const textOf = (res: { json: () => unknown }): string =>
  (res.json() as { response: { text: string } }).response.text;

const UNKNOWN_RE = /не подключено/;

test('ГЛАВНОЕ: вторая колонка того же аккаунта работает без ручного добавления', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // Первая колонка: аккаунт A, устройство 1. Доверенных нет — запоминаем владельца.
  const first = await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });
  assert.equal(textOf(first), ACK, 'первое обращение становится владельцем');

  // Вторая колонка в том же доме: ТОТ ЖЕ аккаунт, ДРУГОЕ устройство и другой
  // устаревший user_id — именно на этом прод и ломался.
  const second = await say(h.app, {
    accountId: 'account-A',
    applicationId: 'speaker-2',
    legacyUserId: 'legacy-completely-different',
    command: 'андрей проснулся',
  });

  assert.equal(second.statusCode, 200);
  assert.equal(textOf(second), ACK, 'вторая колонка обязана работать сразу');
  assert.equal(UNKNOWN_RE.test(textOf(second)), false, 'никакой блокировки');

  // И третья, и телефон — тоже
  const phone = await say(h.app, {
    accountId: 'account-A',
    applicationId: 'phone-android',
    command: 'андрей заснул',
  });
  assert.equal(UNKNOWN_RE.test(textOf(phone)), false);
});

test('устаревший user_id больше не решает: он разный на каждом устройстве', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', applicationId: 'app-1', legacyUserId: 'legacy-1' });

  // тот же аккаунт, но все «устройственные» поля другие
  const res = await say(h.app, {
    accountId: 'account-A',
    applicationId: 'app-999',
    legacyUserId: 'legacy-999',
  });
  assert.equal(UNKNOWN_RE.test(textOf(res)), false, 'опознание должно идти по аккаунту');
});

test('чужой аккаунт отклоняется отличимой фразой, а не «сбоем сервера»', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });

  const alien = await say(h.app, { accountId: 'account-B', applicationId: 'speaker-B' });
  assert.equal(alien.statusCode, 200, 'Алисе всегда 200');

  const text = textOf(alien);
  assert.match(text, UNKNOWN_RE, 'по голосу должно быть понятно, что делать');
  assert.notEqual(text, 'Извините, сейчас не могу ответить.', 'это не сбой сервера');
  assert.match(text, /админк|подключени/i, 'в ответе есть подсказка');

  // событий чужого аккаунта в базе быть не должно
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1, 'записан только владелец');
});

test('неопознанное обращение видно через API, а не только в логах', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });
  await say(h.app, { accountId: 'account-B', applicationId: 'speaker-B', skillId: 'skill-1' });

  const res = await h.app.inject({ method: 'GET', url: '/api/alice/pending' });
  assert.equal(res.statusCode, 200);
  const { pending } = res.json() as {
    pending: Array<{ id: number; kind: string; identity: string; accountId: string | null; applicationId: string | null; legacyUserId: string | null; skillId: string | null }>;
  };

  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, 'account');
  assert.equal(pending[0]?.identity, 'account-B');
  // все три поля идентичности сохранены для разбирательства
  assert.equal(pending[0]?.applicationId, 'speaker-B');
  assert.ok(pending[0]?.legacyUserId);
  assert.equal(pending[0]?.skillId, 'skill-1');
});

test('подтверждение устройства из админки: одно нажатие и оно работает', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });
  await say(h.app, { accountId: 'account-B', applicationId: 'speaker-B' });

  const { pending } = (
    await h.app.inject({ method: 'GET', url: '/api/alice/pending' })
  ).json() as { pending: Array<{ id: number }> };

  const trusted = await h.app.inject({
    method: 'POST',
    url: `/api/alice/pending/${pending[0]?.id}/trust`,
  });
  assert.equal(trusted.statusCode, 200);

  const after = await say(h.app, { accountId: 'account-B', applicationId: 'speaker-B' });
  assert.equal(UNKNOWN_RE.test(textOf(after)), false, 'после подтверждения должно работать');

  // и список неопознанных опустел
  const left = (
    await h.app.inject({ method: 'GET', url: '/api/alice/pending' })
  ).json() as { pending: unknown[] };
  assert.equal(left.pending.length, 0);
});

test('режим подключения: открыли окно — новая колонка сама стала доверенной', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });

  // без окна — отказ
  assert.match(textOf(await say(h.app, { accountId: 'account-NEW' })), UNKNOWN_RE);

  const opened = await h.app.inject({
    method: 'POST',
    url: '/api/alice/enroll',
    payload: { minutes: 10 },
  });
  assert.equal(opened.statusCode, 202);
  assert.ok((opened.json() as { enrollOpenUntil: string }).enrollOpenUntil);

  const enrolled = await say(h.app, { accountId: 'account-NEW', applicationId: 'speaker-NEW' });
  assert.equal(UNKNOWN_RE.test(textOf(enrolled)), false, 'окно должно пустить устройство');

  // окно одноразовое: следующее незнакомое устройство уже не пройдёт
  assert.match(textOf(await say(h.app, { accountId: 'account-THIRD' })), UNKNOWN_RE);
});

test('неавторизованное устройство опознаётся по application_id', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // объекта user нет — пользователь не авторизован
  const first = await say(h.app, { accountId: null, applicationId: 'speaker-noauth' });
  assert.equal(UNKNOWN_RE.test(textOf(first)), false);

  const same = await say(h.app, { accountId: null, applicationId: 'speaker-noauth', command: 'проснулся' });
  assert.equal(UNKNOWN_RE.test(textOf(same)), false, 'то же устройство продолжает работать');

  const other = await say(h.app, { accountId: null, applicationId: 'speaker-other' });
  assert.match(textOf(other), UNKNOWN_RE, 'другое устройство без аккаунта — незнакомое');
});

test('вход в аккаунт на доверенном устройстве не запирает владельца', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // сначала колонка без авторизации
  await say(h.app, { accountId: null, applicationId: 'speaker-1' });

  // владелец вошёл в аккаунт — теперь приходит user.user_id, которого мы не знали
  const afterLogin = await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });
  assert.equal(UNKNOWN_RE.test(textOf(afterLogin)), false, 'это тот же человек, запирать нельзя');

  // и аккаунт теперь доверенный сам по себе: другая колонка работает
  const second = await say(h.app, { accountId: 'account-A', applicationId: 'speaker-2' });
  assert.equal(UNKNOWN_RE.test(textOf(second)), false);

  const { identities } = (
    await h.app.inject({ method: 'GET', url: '/api/alice/identities' })
  ).json() as { identities: Array<{ kind: string; source: string; status: string }> };
  assert.ok(
    identities.some((i) => i.kind === 'account' && i.source === 'promoted' && i.status === 'trusted'),
    'аккаунт должен был подняться до доверенного',
  );
});

test('доверие переживает перезапуск: оно в БД, а не в памяти', async (t) => {
  const cfg = testConfig();
  const db = testDb();

  const first = createApp({ cfg, db, logger: false, serveStatic: false });
  await first.app.ready();
  await first.app.inject({
    method: 'POST',
    url: URL_OK,
    payload: bodyWith({ accountId: 'account-A', applicationId: 'speaker-1' }),
  });
  first.sse.close();
  await first.app.close();

  // новый процесс, та же база
  const second = createApp({ cfg, db, logger: false, serveStatic: false });
  await second.app.ready();
  t.after(async () => {
    second.sse.close();
    await second.app.close();
    db.close();
  });

  const res = await second.app.inject({
    method: 'POST',
    url: URL_OK,
    payload: bodyWith({ accountId: 'account-A', applicationId: 'speaker-2', command: 'проснулся' }),
  });
  assert.equal(UNKNOWN_RE.test(textOf(res)), false, 'после перезапуска владелец остаётся владельцем');
});

test('совместимость: заданный ALICE_ALLOWED_USER_IDS уважается по любому из трёх полей', async (t) => {
  // на проде там лежат значения устаревшего user_id
  const h = await makeTestApp({ ALICE_ALLOWED_USER_IDS: 'legacy-prod-1, account-prod-2' });
  t.after(() => h.close());

  const byLegacy = await say(h.app, { accountId: null, legacyUserId: 'legacy-prod-1', applicationId: 'x' });
  assert.equal(UNKNOWN_RE.test(textOf(byLegacy)), false, 'совпадение по устаревшему полю');

  const byAccount = await say(h.app, { accountId: 'account-prod-2', applicationId: 'y' });
  assert.equal(UNKNOWN_RE.test(textOf(byAccount)), false, 'совпадение по аккаунту');

  const alien = await say(h.app, { accountId: 'account-zzz', applicationId: 'z' });
  assert.match(textOf(alien), UNKNOWN_RE, 'чужой по-прежнему не проходит');
});

test('заданный список выключает доверие первому', async (t) => {
  const h = await makeTestApp({ ALICE_ALLOWED_USER_IDS: 'only-this-one' });
  t.after(() => h.close());

  // база пуста, но список задан — «первого встречного» не пускаем
  const stranger = await say(h.app, { accountId: 'account-random' });
  assert.match(textOf(stranger), UNKNOWN_RE, 'иначе белый список не имел бы смысла');
});

test('ALICE_IDENTITY_CHECK=false пускает всех, но обращения фиксирует', async (t) => {
  const h = await makeTestApp({ ALICE_IDENTITY_CHECK: 'false' });
  t.after(() => h.close());

  for (const accountId of ['account-A', 'account-B', 'account-C']) {
    const res = await say(h.app, { accountId });
    assert.equal(UNKNOWN_RE.test(textOf(res)), false, `${accountId} должен пройти`);
  }

  const { identities } = (
    await h.app.inject({ method: 'GET', url: '/api/alice/identities' })
  ).json() as { identities: unknown[] };
  assert.equal(identities.length, 3, 'кто приходил — видно в админке');
});

test('снятие доверия работает', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });

  const { identities } = (
    await h.app.inject({ method: 'GET', url: '/api/alice/identities' })
  ).json() as { identities: Array<{ id: number; status: string }> };
  const id = identities.find((i) => i.status === 'trusted')?.id;
  assert.ok(id);

  const revoked = await h.app.inject({ method: 'DELETE', url: `/api/alice/identities/${id}` });
  assert.equal(revoked.statusCode, 200);

  const after = await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });
  assert.match(textOf(after), UNKNOWN_RE, 'после снятия доверия устройство незнакомое');
});

test('неверный секрет остаётся нейтральным: подсказывать атакующему нечего', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: '/alice/ffffffffffffffffffffffffffffffff',
    payload: bodyWith({ accountId: 'account-A' }),
  });

  const text = textOf(res);
  assert.equal(text, 'Извините, сейчас не могу ответить.');
  assert.equal(UNKNOWN_RE.test(text), false, 'про устройства ему знать незачем');
  // и в список неопознанных такое не попадает
  const { pending } = (
    await h.app.inject({ method: 'GET', url: '/api/alice/pending' })
  ).json() as { pending: unknown[] };
  assert.equal(pending.length, 0);
});

test('строгий ALICE_SKILL_ID по-прежнему жёсткий рубеж', async (t) => {
  const h = await makeTestApp({ ALICE_SKILL_ID: 'my-skill' });
  t.after(() => h.close());

  const alien = await say(h.app, { accountId: 'account-A', skillId: 'other-skill' });
  assert.equal(textOf(alien), 'Извините, сейчас не могу ответить.');

  const own = await say(h.app, { accountId: 'account-A', skillId: 'my-skill' });
  assert.equal(UNKNOWN_RE.test(textOf(own)), false);
});

test('skill_id запоминается по первому обращению', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', skillId: 'skill-запомнить' });

  const res = (
    await h.app.inject({ method: 'GET', url: '/api/alice/identities' })
  ).json() as { knownSkillId: string | null };
  assert.equal(res.knownSkillId, 'skill-запомнить');
});

test('битая идентичность не роняет вебхук', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const payload of [
    { session: { user: null }, request: { command: 'заснул' }, version: '1.0' },
    { session: { user: { user_id: 42 } }, request: { command: 'заснул' }, version: '1.0' },
    { session: {}, request: { command: 'заснул' }, version: '1.0' },
  ]) {
    const res = await h.app.inject({ method: 'POST', url: URL_OK, payload });
    assert.equal(res.statusCode, 200, `payload: ${JSON.stringify(payload)}`);
    assert.equal((res.json() as { version: string }).version, '1.0');
  }
});


test('битый id в ручках устройств отклоняется, а не трактуется как число', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });

  for (const bad of ['1abc', '1.5', '+1', '0', '-1', 'абв', '1e0']) {
    const trust = await h.app.inject({ method: 'POST', url: `/api/alice/pending/${bad}/trust` });
    assert.equal(trust.statusCode, 400, `trust с id="${bad}" должен быть отклонён`);

    const revoke = await h.app.inject({ method: 'DELETE', url: `/api/alice/identities/${bad}` });
    assert.equal(revoke.statusCode, 400, `revoke с id="${bad}" должен быть отклонён`);
  }

  // доверенная запись не пострадала
  const after = await say(h.app, { accountId: 'account-A', applicationId: 'speaker-1' });
  assert.equal(UNKNOWN_RE.test(textOf(after)), false);
});

/* ------------------------------------------------------------------ */
/* Кому принадлежит микрофон после ответа                              */
/*                                                                      */
/* Прод-инцидент: «Алиса, скажи дневнику Андрея, что он закончил есть   */
/* грудь» — записали верно, но сессию не закрыли. Следующая фраза       */
/* «включи свет в гостиной» прилетела НАМ: в дневнике мусор, свет не    */
/* включился. Навык сломал бытовое пользование колонкой.                */
/* ------------------------------------------------------------------ */

/** Тело запроса с раздельным управлением session.new и командой. */
function sessionBody(opts: { isNew?: boolean; command?: string }): Record<string, unknown> {
  const session: Record<string, unknown> = {
    message_id: 0,
    session_id: 'mic-session',
    skill_id: 'skill-1',
    user: { user_id: 'account-mic' },
    application: { application_id: 'speaker-mic' },
    user_id: 'legacy-mic',
  };
  if (opts.isNew !== undefined) session.new = opts.isNew;

  return {
    meta: { locale: 'ru-RU', timezone: 'Europe/Moscow', interfaces: {} },
    session,
    request: {
      type: 'SimpleUtterance',
      command: opts.command ?? '',
      original_utterance: opts.command ?? '',
      nlu: { tokens: [], entities: [], intents: {} },
    },
    version: '1.0',
  };
}

const endSession = (res: { json: () => unknown }): boolean =>
  (res.json() as { response: { end_session: boolean } }).response.end_session;

test('одной фразой: отвечаем и ОТПУСКАЕМ микрофон', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // «Алиса, скажи дневнику Андрея, что он закончил есть грудь»
  const res = await h.app.inject({
    method: 'POST',
    url: URL_OK,
    payload: sessionBody({ isNew: true, command: 'андрей закончил есть грудь' }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(
    endSession(res),
    true,
    'сессию обязаны закрыть, иначе следующая бытовая команда прилетит нам',
  );
});

test('явный запуск без команды: держим микрофон для диктовки', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: URL_OK,
    payload: sessionBody({ isNew: true, command: '' }),
  });

  assert.equal(endSession(res), false, 'человек открыл диалог, чтобы надиктовать несколько событий');
  assert.match(textOf(res), /Привет/);
});

test('продолжение внутри диктовки: держим до «хватит»', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await h.app.inject({ method: 'POST', url: URL_OK, payload: sessionBody({ isNew: true, command: '' }) });

  for (const command of ['андрей заснул', 'андрей проснулся', 'покормили из бутылочки']) {
    const res = await h.app.inject({
      method: 'POST',
      url: URL_OK,
      payload: sessionBody({ isNew: false, command }),
    });
    assert.equal(endSession(res), false, `«${command}» не должна обрывать диктовку`);
  }

  const bye = await h.app.inject({
    method: 'POST',
    url: URL_OK,
    payload: sessionBody({ isNew: false, command: 'хватит' }),
  });
  assert.equal(endSession(bye), true, '«хватит» закрывает диалог');
});

test('ПРОД-СЦЕНАРИЙ: после одной фразы чужая команда к нам не попадает', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const first = await h.app.inject({
    method: 'POST',
    url: URL_OK,
    payload: sessionBody({ isNew: true, command: 'андрей закончил есть грудь' }),
  });
  assert.equal(endSession(first), true);

  // Алиса забрала управление, поэтому «включи свет» до нас не доходит вовсе.
  // В дневнике — ровно то, что сказал человек, и ни одной лишней фразы.
  const utterances = listUtterances(h.db);
  assert.equal(utterances.length, 1, 'ровно одна фраза');
  assert.equal(utterances[0]?.raw_text, 'андрей закончил есть грудь');
  assert.equal(
    utterances.some((u) => /свет|гостин/i.test(u.raw_text)),
    false,
    'чужих команд в ленте быть не должно',
  );
});

test('одношаговые вопрос и мусор тоже отпускают микрофон', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const command of ['сколько он сегодня спал', 'абырвалг колбаса', 'спит ли он']) {
    const res = await h.app.inject({
      method: 'POST',
      url: URL_OK,
      payload: sessionBody({ isNew: true, command }),
    });
    assert.equal(endSession(res), true, `«${command}»: одна фраза — один ответ`);
  }
});

test('без поля session.new микрофон отпускается: удержание дороже ошибки', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: URL_OK,
    payload: sessionBody({ command: 'андрей заснул' }),
  });
  assert.equal(endSession(res), true);
});
