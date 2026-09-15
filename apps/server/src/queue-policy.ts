/**
 * Политика запуска модели (§9.4).
 *
 * Принцип (§10.3, пересмотрен после трёх инцидентов): решение принимает не
 * уверенность матчера, а КАНОНИЧНОСТЬ фразы. Короткая форма, каждое слово
 * которой матчеру знакомо, обрабатывается им самим; всё остальное уходит модели.
 *
 * Это дороже по вызовам, и это осознанно: цена лишнего вызова — часть окна
 * лимита подписки, цена пропущенного факта — потерянная запись в дневнике
 * ребёнка, которой никто не хватится.
 */

import type { LlmQueuePolicy } from './config.ts';
import type { FastResult } from './types.ts';
import { checkCanonical, looksLikeDataCommand } from './fastpath.ts';

export interface QueueDecision {
  /** Отправлять ли фразу в очередь на разбор моделью. */
  queue: boolean;
  /** Человекочитаемая причина — попадает в ленту распознавания на дашборде. */
  reason: string;
}

export interface QueueDecisionInput {
  policy: LlmQueuePolicy;
  threshold: number;
  fast: FastResult;
  command: string;
}

export function decideQueue(input: QueueDecisionInput): QueueDecision {
  const { policy, threshold, fast, command } = input;

  // ---- Признаки, перебивающие ЛЮБУЮ политику ----
  // Это не эвристики экономии, а известные причины тихой потери данных:
  // каждая из них уже случалась на проде.

  if (fast.mayContainMore) {
    return { queue: true, reason: 'во фразе может быть ещё событие, кроме распознанного' };
  }

  if (fast.timeUnresolved) {
    return { queue: true, reason: 'во фразе названо время, но разобрать его не удалось' };
  }

  // Команда управления данными: матчер такое не умеет в принципе.
  if (looksLikeDataCommand(command)) {
    return { queue: true, reason: 'похоже на команду правки данных' };
  }

  // ---- Политика ----

  if (policy === 'all') {
    return { queue: true, reason: 'политика all: разбираем каждую фразу' };
  }

  if (policy === 'unknown') {
    // Самый экономный режим: зовём модель, только если матчер совсем не понял.
    // Осознанно небезопасен — составная фраза из знакомых слов здесь теряет
    // факты молча. Умолчание проекта не он, а smart.
    return fast.kind === 'unknown'
      ? { queue: true, reason: 'fast-path не понял фразу' }
      : { queue: false, reason: `политика unknown: fast-path разобрал как ${fast.kind}` };
  }

  // policy === 'smart' — направление решения перевёрнуто (см. checkCanonical):
  // не «матчер уверен, значит не зовём», а «фраза совпала с канонической
  // формой, значит не зовём». Всё остальное уходит модели.
  const canon = checkCanonical(command, fast);
  if (!canon.canonical) {
    return { queue: true, reason: canon.reason };
  }

  // Порог уверенности остаётся дополнительным условием: каноничность — про
  // форму фразы, confidence — про качество совпадения со словарём.
  const confidence = 'confidence' in fast ? fast.confidence : 1;
  if (confidence < threshold) {
    return { queue: true, reason: `уверенность ${confidence} ниже порога ${threshold}` };
  }

  return { queue: false, reason: canon.reason };
}
