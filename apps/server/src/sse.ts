/**
 * SSE-рассылка (§3.6): события `state`, `event`, `utterance`.
 *
 * Heartbeat раз в 15 секунд обязателен: без трафика Cloudflare Tunnel рвёт
 * соединение, а дашборд на телевизоре молча замирает.
 */

import type { FastifyReply } from 'fastify';
import type { EventRow, StateDto, UtteranceDto } from './types.ts';

export const HEARTBEAT_MS = 15_000;

export type SseEventName = 'state' | 'event' | 'utterance';

export interface SseEventPayload {
  action: 'created' | 'updated' | 'deleted';
  event: EventRow;
}

interface Client {
  id: number;
  /**
   * Чья это сессия. Нужна ровно для одного: отзыв устройства обязан оборвать
   * уже открытый поток. Без этого отозванный телевизор продолжал бы получать
   * события ребёнка часами — проверка на входе его больше не касается,
   * соединение-то уже установлено.
   */
  sessionId: string | null;
  write: (chunk: string) => void;
  close: () => void;
}

export interface SseHubOptions {
  heartbeatMs?: number;
  onError?: (err: unknown) => void;
  /**
   * Жива ли ещё сессия этого потока. Проверяется на каждом heartbeat.
   *
   * Отзыв устройства рвёт поток сразу и явно (`closeSession`), так что это
   * не основной механизм, а второй рубеж: он ловит случаи, до которых явный
   * разрыв не дотягивается — истёкшую сессию и отзыв, сделанный мимо
   * работающего сервера (например, командой `auth revoke` по ssh).
   */
  isSessionLive?: (sessionId: string) => boolean;
}

export class SseHub {
  #clients = new Map<number, Client>();
  #nextId = 1;
  #timer: NodeJS.Timeout | null = null;
  #heartbeatMs: number;
  #onError: (err: unknown) => void;
  #isSessionLive: ((sessionId: string) => boolean) | null;

  constructor(options: SseHubOptions = {}) {
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#onError = options.onError ?? (() => {});
    this.#isSessionLive = options.isSessionLive ?? null;
  }

  /** Ставится после создания хаба: проверке нужна БД, а хаб создаётся раньше. */
  setSessionCheck(fn: (sessionId: string) => boolean): void {
    this.#isSessionLive = fn;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Подключает reply как SSE-поток. Возвращает id клиента. */
  attach(reply: FastifyReply, sessionId: string | null = null): number {
    const id = this.#nextId++;
    const raw = reply.raw;

    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx/облачные прокси любят буферизовать — явно запрещаем
      'X-Accel-Buffering': 'no',
    });
    raw.write(`retry: 3000\n\n`);

    const client: Client = {
      id,
      sessionId,
      write: (chunk) => {
        raw.write(chunk);
      },
      close: () => {
        try {
          raw.end();
        } catch {
          /* соединение уже мертво */
        }
      },
    };

    this.#clients.set(id, client);

    const drop = (): void => {
      this.#clients.delete(id);
      this.#maybeStopHeartbeat();
    };
    raw.on('close', drop);
    raw.on('error', drop);

    this.#ensureHeartbeat();
    return id;
  }

  /** Отправка именованного события всем подписчикам. */
  broadcast(name: SseEventName, data: unknown): void {
    if (this.#clients.size === 0) return;
    let frame: string;
    try {
      frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch (err) {
      this.#onError(err);
      return;
    }
    this.#writeAll(frame);
  }

  broadcastState(state: StateDto): void {
    this.broadcast('state', state);
  }

  broadcastEvent(action: SseEventPayload['action'], event: EventRow): void {
    this.broadcast('event', { action, event });
  }

  broadcastUtterance(utterance: UtteranceDto): void {
    this.broadcast('utterance', utterance);
  }

  /** Точечная отправка одному клиенту (первичный снимок состояния). */
  sendTo(id: number, name: SseEventName, data: unknown): void {
    const client = this.#clients.get(id);
    if (!client) return;
    try {
      client.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      this.#clients.delete(id);
      this.#onError(err);
    }
  }

  /**
   * Оборвать все потоки отозванной сессии. Возвращает, сколько оборвали.
   *
   * Это вторая половина отзыва устройства: первая — пометка в БД, после
   * которой ни один НОВЫЙ запрос не пройдёт дверь. Но SSE-соединение живёт
   * часами и двери больше не показывается, поэтому его закрывают явно.
   * Потерянный телефон должен замолчать в ту же секунду, а не когда ему
   * надоест держать сокет.
   */
  closeSession(sessionId: string): number {
    let closed = 0;
    for (const [id, client] of [...this.#clients]) {
      if (client.sessionId !== sessionId) continue;
      this.#clients.delete(id);
      client.close();
      closed += 1;
    }
    this.#maybeStopHeartbeat();
    return closed;
  }

  close(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const client of this.#clients.values()) client.close();
    this.#clients.clear();
  }

  #writeAll(frame: string): void {
    for (const [id, client] of this.#clients) {
      try {
        client.write(frame);
      } catch (err) {
        this.#clients.delete(id);
        this.#onError(err);
      }
    }
    this.#maybeStopHeartbeat();
  }

  #ensureHeartbeat(): void {
    if (this.#timer || this.#clients.size === 0) return;
    this.#timer = setInterval(() => {
      this.#dropDeadSessions();
      this.#writeAll(`: ping ${Date.now()}\n\n`);
    }, this.#heartbeatMs);
    this.#timer.unref();
  }

  /**
   * Закрыть потоки, чья сессия перестала быть живой.
   *
   * Проверка на входе потоку больше не встретится: соединение установлено и
   * висит часами. Без этого истёкшая сессия продолжала бы получать события
   * ребёнка ровно до тех пор, пока не оборвётся сеть.
   */
  #dropDeadSessions(): void {
    const check = this.#isSessionLive;
    if (!check || this.#clients.size === 0) return;
    for (const [id, client] of [...this.#clients]) {
      if (client.sessionId === null) continue;
      let live: boolean;
      try {
        live = check(client.sessionId);
      } catch (err) {
        // База занята или закрывается — это не повод рвать живым людям поток.
        this.#onError(err);
        continue;
      }
      if (live) continue;
      this.#clients.delete(id);
      client.close();
    }
  }

  #maybeStopHeartbeat(): void {
    if (this.#clients.size === 0 && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
