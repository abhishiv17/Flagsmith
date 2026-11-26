/** Tiny structured logger. Never log connection strings, passwords or full emails. */
type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "asha@example.com" -> "a***@example.com" */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}
