/**
 * Точка входа: конфиг -> БД -> HTTP -> воркер, и аккуратное выключение.
 *
 * Запуск: `node --env-file-if-exists=.env src/index.ts` (Node >= 24,
 * TypeScript исполняется напрямую, сборка не нужна).
 */

import process from 'node:process';
import { ConfigError, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { createWorker } from './worker.ts';

export async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\n`);
      process.exit(1);
    }
    throw err;
  }

  // Локальная таймзона процесса — чтобы логи и любые «голые» Date совпадали
  // с тем, что видит пользователь. В БД всё равно пишем только UTC.
  process.env.TZ = cfg.tz;

  const db = openDb({ path: cfg.dbPath });
  const { app, ctx, sse, setWorkerStatus, setWorkerNotify } = createApp({ cfg, db });

  const worker = createWorker(ctx);
  setWorkerStatus(worker.status);
  setWorkerNotify(worker.notify);
  worker.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'останавливаемся');

    void (async () => {
      try {
        sse.close();
        await worker.stop();
        await app.close();
        db.close();
      } catch (err) {
        app.log.error({ err }, 'ошибка при остановке');
      } finally {
        process.exit(0);
      }
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Падать из-за необработанного промиса нельзя: сервер должен пережить и это.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaughtException');
  });

  await app.listen({ port: cfg.port, host: cfg.host });

  app.log.info(
    {
      port: cfg.port,
      tz: cfg.tz,
      db: cfg.dbPath,
      child: cfg.childName,
      worker: cfg.workerEnabled,
      // секрет НЕ логируем — только форму URL
      webhook: `/alice/<ALICE_WEBHOOK_SECRET>`,
      pairing: '/pair',
    },
    'BabyTracker server готов',
  );

  // Кука сессии без Secure уходит по http в открытом виде. В бою это дыра,
  // поэтому предупреждение громкое и на каждом старте: тихая небезопасная
  // настройка — это настройка, про которую забывают.
  if (!cfg.authCookieSecure) {
    app.log.warn(
      'AUTH_COOKIE_SECURE=false — кука сессии отдаётся БЕЗ флага Secure. ' +
        'Допустимо только для локальной разработки без TLS.',
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`Не удалось запустить сервер: ${String(err)}\n`);
    process.exit(1);
  });
}
