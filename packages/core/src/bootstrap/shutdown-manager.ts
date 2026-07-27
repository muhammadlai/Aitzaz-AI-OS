import { NexusError } from '../errors/index.js';
import type { NexusKernel } from '../kernel/index.js';
import { withTimeout } from '../utils/index.js';

/** Coordinates one idempotent, bounded graceful shutdown across runtime services. */
export class ShutdownManager {
  private shutdownPromise: Promise<void> | undefined;
  public constructor(private readonly kernel: NexusKernel, private readonly timeoutMs = 10_000) {}

  public async shutdown(reason = 'requested'): Promise<void> {
    if (this.shutdownPromise !== undefined) return await this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(reason);
    return await this.shutdownPromise;
  }

  private async performShutdown(reason: string): Promise<void> {
    try {
      await this.kernel.events.emit('shuttingDown', { reason });
      await withTimeout(this.kernel.runtime.stop(), this.timeoutMs, 'Nexus runtime shutdown');
      await this.kernel.events.emit('shutdown', { reason });
      this.kernel.logger.info('Nexus runtime stopped', { reason });
    } catch (error) {
      this.kernel.logger.fatal('Nexus runtime shutdown failed', error, { reason });
      throw error instanceof NexusError ? error : new NexusError('INTERNAL', 'Nexus runtime shutdown failed', { cause: error });
    }
  }
}
