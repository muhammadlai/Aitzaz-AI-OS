import type { LifecyclePhase, LogLevel } from '../types/index.js';

export const NEXUS_NAME = 'Nexus AI OS';
export const NEXUS_VERSION = '0.1.0';
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_API_PORT = 8787;
export const DEFAULT_CACHE_TTL_MS = 60_000;
export const LIFECYCLE_PHASES: readonly LifecyclePhase[] = ['bootstrap', 'initialize', 'ready', 'shutdown'];
export const MAX_COMMAND_NAME_LENGTH = 96;
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;
export const DEFAULT_SCHEDULER_CONCURRENCY = 4;
