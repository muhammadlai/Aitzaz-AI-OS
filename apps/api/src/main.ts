import 'dotenv/config';
import { RecordEnvironmentSource, StartupBootstrap } from '@nexus/core';
import { createApi } from './app.js';

const environment = new RecordEnvironmentSource(process.env);
const bootstrapped = await new StartupBootstrap().boot({ environment });
const { kernel, shutdown } = bootstrapped;
const authSecret = process.env.NEXUS_AUTH_SECRET;
const app = createApi({ kernel, ...(authSecret === undefined ? {} : { authSecret }) });
const server = app.listen(kernel.config.api.port, kernel.config.api.host, () => {
  kernel.logger.info('Nexus API listening', { host: kernel.config.api.host, port: kernel.config.api.port });
});

let stopping = false;
const stop = async (reason: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  await shutdown.shutdown(reason);
};

process.once('SIGINT', () => { void stop('SIGINT').catch((error: unknown) => { kernel.logger.fatal('SIGINT shutdown failed', error); process.exitCode = 1; }); });
process.once('SIGTERM', () => { void stop('SIGTERM').catch((error: unknown) => { kernel.logger.fatal('SIGTERM shutdown failed', error); process.exitCode = 1; }); });
