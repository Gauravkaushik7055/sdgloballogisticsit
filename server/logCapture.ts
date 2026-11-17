import util from 'util';

export type ConsoleLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SYNC' | 'DB';

export interface CapturedLogEntry {
  seq: number;
  timestamp: string;
  level: ConsoleLogLevel;
  source: string;
  message: string;
}

const MAX_LOG_ENTRIES = 2500;
const logBuffer: CapturedLogEntry[] = [];
let seqCounter = 0;
let initialized = false;

function pushEntry(level: ConsoleLogLevel, source: string, message: string) {
  seqCounter += 1;
  const entry: CapturedLogEntry = {
    seq: seqCounter,
    timestamp: new Date().toISOString(),
    level,
    source,
    message: message.slice(0, 4000),
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  }
}

export function initConsoleLogCapture() {
  if (initialized) return;
  initialized = true;

  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: any[]) => {
    pushEntry('INFO', 'console', util.format(...args));
    origLog(...args);
  };

  console.info = (...args: any[]) => {
    pushEntry('INFO', 'console', util.format(...args));
    origInfo(...args);
  };

  console.warn = (...args: any[]) => {
    pushEntry('WARN', 'console', util.format(...args));
    origWarn(...args);
  };

  console.error = (...args: any[]) => {
    pushEntry('ERROR', 'console', util.format(...args));
    origError(...args);
  };

  pushEntry('INFO', 'system', 'Console & database log capture initialized.');
}

export function appendSystemLog(level: ConsoleLogLevel, source: string, message: string) {
  pushEntry(level, source, message);
}

export function getConsoleLogVersion(): number {
  return seqCounter;
}

export function getConsoleLogs(limit = 300): CapturedLogEntry[] {
  const n = Math.max(1, Math.min(MAX_LOG_ENTRIES, limit));
  return logBuffer.slice(-n);
}

export function getConsoleLogText(limit = 2000): string {
  const entries = getConsoleLogs(limit);
  return entries
    .map((e) => `[${e.timestamp}] [${e.level}] [${e.source}] ${e.message}`)
    .join('\n');
}
