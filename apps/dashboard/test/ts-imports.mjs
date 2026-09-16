/**
 * Тесты гоняет сам node (`node --test`), без сборщика и без единой зависимости.
 *
 * Исходники админки пишутся под vite и импортируются без расширения
 * (`from './taxonomy'`), а node по спецификации ESM требует полный путь.
 * Хук дописывает `.ts` — этого хватает, типы node снимает сам.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* не .ts — пусть отвечает обычный резолвер */
      }
    }
    return next(specifier, context);
  },
});
