/**
 * Logger utility with per-user log files and verbose console logging
 *
 * Features:
 * - Writes all logs to user-specific log files
 * - Only displays in console when --verbose or -v flag is set
 * - Supports different log levels (info, warn, error, debug)
 * - Automatically creates log directory if it doesn't exist
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  username?: string;
  verbose?: boolean;
  logDir?: string;
}

export class Logger {
  private username: string;
  private verbose: boolean;
  private logDir: string;
  private logFilePath: string;

  constructor(options: LoggerOptions = {}) {
    this.username = options.username || 'default';
    this.verbose = options.verbose || false;
    this.logDir = options.logDir || join(homedir(), '.broadcast-on-all-channels', 'logs');
    this.logFilePath = join(this.logDir, `${this.username}.log`);

    // Ensure log directory exists
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Set whether to display logs in console
   */
  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  /**
   * Update the username (useful when user changes identity)
   */
  setUsername(username: string): void {
    this.username = username;
    this.logFilePath = join(this.logDir, `${username}.log`);
  }

  /**
   * Format log message with timestamp and level
   */
  private formatMessage(level: LogLevel, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  }

  /**
   * Write to log file
   */
  private writeToFile(formattedMessage: string): void {
    try {
      appendFileSync(this.logFilePath, formattedMessage + '\n', 'utf-8');
    } catch (error) {
      // Fallback to console.error if file write fails
      console.error('Failed to write to log file:', error);
    }
  }

  /**
   * Log debug message
   */
  debug(...args: any[]): void {
    const formatted = this.formatMessage('debug', ...args);
    this.writeToFile(formatted);
    if (this.verbose) {
      console.debug(...args);
    }
  }

  /**
   * Log info message
   */
  info(...args: any[]): void {
    const formatted = this.formatMessage('info', ...args);
    this.writeToFile(formatted);
    if (this.verbose) {
      console.log(...args);
    }
  }

  /**
   * Log warning message
   */
  warn(...args: any[]): void {
    const formatted = this.formatMessage('warn', ...args);
    this.writeToFile(formatted);
    if (this.verbose) {
      console.warn(...args);
    }
  }

  /**
   * Log error message (always shown in console)
   */
  error(...args: any[]): void {
    const formatted = this.formatMessage('error', ...args);
    this.writeToFile(formatted);
    // Errors are always shown, even without verbose
    console.error(...args);
  }

  /**
   * Get the path to the current log file
   */
  getLogFilePath(): string {
    return this.logFilePath;
  }
}

// Global logger instance
let globalLogger: Logger | null = null;

/**
 * Initialize the global logger
 */
export function initLogger(options: LoggerOptions): Logger {
  globalLogger = new Logger(options);
  return globalLogger;
}

/**
 * Get the global logger instance
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger();
  }
  return globalLogger;
}

/**
 * Helper to check if verbose mode is enabled from CLI args
 */
export function isVerboseMode(): boolean {
  const args = process.argv.slice(2);
  return args.includes('--verbose') || args.includes('-v');
}
