import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One line read from the server's stdout, parsed if it was JSON. */
export interface Line {
  raw: string;
  message?: JsonObject;
}

/**
 * Speaks newline-delimited JSON-RPC to a server process over stdio, as the MCP stdio transport
 * requires. Deliberately low level: it records every stdout line, so the checks can judge what the
 * server actually sent rather than what an SDK made of it.
 */
export class StdioConnection {
  readonly lines: Line[] = [];
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private waiters: Array<() => void> = [];
  private exited = false;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (raw) => {
      if (raw.trim() === '') return;
      let message: JsonObject | undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          message = parsed as JsonObject;
        }
      } catch {
        message = undefined;
      }
      this.lines.push({ raw, message });
      this.notify();
    });
    createInterface({ input: this.child.stderr }).on('line', (l) => this.stderr.push(l));
    this.child.on('exit', () => {
      this.exited = true;
      this.notify();
    });
    this.child.on('error', (e) => {
      this.stderr.push(`spawn error: ${e.message}`);
      this.exited = true;
      this.notify();
    });
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  sendRaw(text: string): void {
    this.child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  send(message: JsonObject): void {
    this.sendRaw(JSON.stringify(message));
  }

  /** Wait until a line matching the predicate arrives (searching from `fromIndex`), or time out. */
  async waitFor(
    predicate: (line: Line) => boolean,
    timeoutMs: number,
    fromIndex = 0,
  ): Promise<Line | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.slice(fromIndex).find(predicate);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0 || this.exited) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Send a request and wait for the response carrying the same id (compared by value and type). */
  async request(
    method: string,
    params: JsonObject | undefined,
    id: string | number,
    timeoutMs = 5000,
  ): Promise<JsonObject | undefined> {
    const from = this.lines.length;
    const message: JsonObject = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    this.send(message);
    const line = await this.waitFor(
      (l) => l.message !== undefined && l.message.id === id && !('method' in l.message),
      timeoutMs,
      from,
    );
    return line?.message;
  }

  /** Lines received since `index` that look like responses (have an id and no method). */
  responsesSince(index: number): JsonObject[] {
    return this.lines
      .slice(index)
      .flatMap((l) =>
        l.message && 'id' in l.message && !('method' in l.message) ? [l.message] : [],
      );
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    const done = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    this.child.kill('SIGTERM');
    await done;
    clearTimeout(timer);
  }
}
