import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** A continuously drained JSONL Pi subprocess. Commands and run completion are separate. */
export class PiProcess extends EventEmitter {
  constructor({ executable = 'pi', args = [], cwd, env = {}, timeoutMs = 30000 }) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.exited = false;
    this.child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8000); });
    this.child.on('error', error => this.finish(error));
    this.child.on('exit', (code, signal) => this.finish(new Error(`Pi exited: code=${code}, signal=${signal}`)));
    this.child.stdin.on('error', error => this.finish(error));
  }

  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
      this.finish(new Error('Pi JSONL record exceeded 16 MiB'));
      this.child.kill();
      return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { this.finish(new Error('Pi emitted invalid JSONL')); this.child.kill(); return; }
      if (record.type === 'response') {
        const pending = this.pending.get(record.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(record.id);
          if (record.success) pending.resolve(record.data);
          else pending.reject(new Error(record.error || 'Pi command failed'));
        }
      } else this.emit('event', record);
    }
  }

  command(type, values = {}) {
    if (this.exited) return Promise.reject(new Error('Pi process is not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi command timed out: ${type}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...values, type, id }) + '\n', error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  finish(error) {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('stopped', error);
  }

  async close() {
    if (this.exited) return;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGTERM'); resolve(); }, 2500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!this.exited) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!this.exited) this.child.kill('SIGKILL');
    }
  }
}
