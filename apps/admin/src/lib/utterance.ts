/**
 * Что делать с фразой, которая не породила ни одной записи.
 *
 * Статус `skipped` на сервере означает три разные вещи (apps/server/src/alice.ts,
 * worker.ts), и валить их в одну кучу — прямой путь к янтарной карточке «разбор
 * пропущен» под безобидным вопросом «сколько он сегодня спал»:
 *
 *   1. быстрый матчер справился сам, модель звать не понадобилось — это УСПЕХ;
 *   2. команда выхода из диалога — разбирать нечего;
 *   3. claude недоступен, фразу никто не разобрал — вот это настоящий пробел.
 *
 * Плюс отдельно: вопросы к Алисе («сколько спал», «что там») событиями жизни
 * ребёнка не являются вовсе — это разговор с системой, а не дневник.
 */
import type { Utterance } from '../types';
import { MINUTE, parseTs } from './format';

export type PhraseVerdict =
  /** Показывать не нужно: всё отработало штатно. */
  | { show: false }
  /** Фразу никто не разобрал или разбор упал — это стоит увидеть. */
  | { show: true; tone: 'gap'; title: string; detail: string | null }
  /** Фраза в работе прямо сейчас — спокойная информация, не тревога. */
  | { show: true; tone: 'working'; title: string; detail: string | null };

/** Дольше этого «в очереди» — уже не работа, а застрявшая фраза. */
const STUCK = 10 * MINUTE;

function fastKind(u: Utterance): string | null {
  const fr = u.fast_result;
  if (!fr || typeof fr !== 'object') return null;
  const kind = (fr as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : null;
}

/** Вопрос к Алисе или выход из диалога — не событие жизни ребёнка. */
export function isConversation(u: Utterance): boolean {
  const kind = fastKind(u);
  return kind === 'query_state' || kind === 'exit';
}

export function classifyPhrase(u: Utterance, now = Date.now()): PhraseVerdict {
  // Разговор с системой в дневник не попадает вообще.
  if (isConversation(u)) return { show: false };

  const status = u.status ?? '';
  const kind = fastKind(u);

  if (status === 'failed') {
    return {
      show: true,
      tone: 'gap',
      title: 'Разбор не справился — записей по этой фразе нет',
      detail: u.llm_error ?? null,
    };
  }

  if (status === 'pending' || status === 'processing') {
    const at = parseTs(u.received_at);
    const stuck = at != null && now - at > STUCK;
    return {
      show: true,
      tone: stuck ? 'gap' : 'working',
      title: stuck ? 'Фраза давно ждёт разбора' : 'Фразу сейчас разбирают',
      detail: null,
    };
  }

  if (status === 'skipped') {
    /*
     * Настоящий пробел — только когда быстрый матчер не понял фразу И модель
     * к ней не приходила. Если матчер понял («заснул», «проснулся»), записи
     * либо созданы, либо обновлён уже существующий сон — жаловаться не на что.
     */
    if (kind === null || kind === 'unknown') {
      return {
        show: true,
        tone: 'gap',
        title: 'Фразу никто не разобрал — дневник не изменился',
        detail: u.llm_error ?? null,
      };
    }
    return { show: false };
  }

  // done без новых событий: модель отработала и, как правило, поправила
  // существующую запись («проснулся» закрывает открытый сон). Это не пробел.
  return { show: false };
}
