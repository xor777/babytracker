/**
 * Политика запуска модели (§9.4).
 *
 * Opus на каждое «заснул», которое fast-path и так понял, — это деньги на ветер.
 * Но фразу вроде «убери предыдущую запись» пропустить нельзя ни при какой экономии,
 * поэтому командные слова перебивают любую уверенность матчера.
 */

import type { LlmQueuePolicy } from './config.ts';
import type { FastResult } from './types.ts';
import { looksLikeDataCommand } from './fastpath.ts';

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

  // §10.3. Первым делом и БЕЗ оглядки на политику: во фразе может быть ещё
  // событие, кроме распознанного. Экономия здесь означала бы тихую потерю
  // данных — «покушал и уснул» без этой ветки теряет кормление молча.
  if (fast.mayContainMore) {
    return { queue: true, reason: 'во фразе может быть ещё событие, кроме распознанного' };
  }

  // Команда управления данными идёт модели всегда: fast-path такое не умеет.
  if (looksLikeDataCommand(command)) {
    return { queue: true, reason: 'похоже на команду правки данных' };
  }

  if (policy === 'all') {
    return { queue: true, reason: 'политика all: разбираем каждую фразу' };
  }

  if (fast.kind === 'unknown') {
    return { queue: true, reason: 'fast-path не понял фразу' };
  }

  if (policy === 'unknown') {
    return {
      queue: false,
      reason: `политика unknown: fast-path разобрал как ${fast.kind}`,
    };
  }

  // policy === 'smart'
  const confidence = 'confidence' in fast ? fast.confidence : 1;
  if (confidence < threshold) {
    return {
      queue: true,
      reason: `уверенность fast-path ${confidence} ниже порога ${threshold}`,
    };
  }

  return {
    queue: false,
    reason: `fast-path уверенно разобрал как ${fast.kind} (${confidence} >= ${threshold})`,
  };
}
