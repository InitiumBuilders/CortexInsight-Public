// ============================================================================
//  client.js — one small connection to the running console.
//
//  Everything that talks to the daemon goes through here: the terminal, the
//  stdio bridge the desktop app reaches over SSH, and the health check. One
//  place to get the framing right, one place that knows what a missing socket
//  means and says so in words a person can act on.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

function defaultSocket() {
  if (process.env.CORTEX_SOCKET) return process.env.CORTEX_SOCKET;
  const rt = process.env.XDG_RUNTIME_DIR;
  if (rt) {
    const p = path.join(rt, 'cortexinsight', 'control.sock');
    if (fs.existsSync(p)) return p;
  }
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(cfg, 'cortexinsight', 'run', 'control.sock');
}

class Client {
  constructor(sock) {
    this.sock = sock || defaultSocket();
    this.conn = null;
    this.seq = 0;
    this.waiting = new Map();
    this.onPush = null;
    this.buf = '';
  }

  connect() {
    return new Promise((resolve, reject) => {
      const c = net.connect(this.sock);
      c.setEncoding('utf8');
      c.once('connect', () => { this.conn = c; resolve(this); });
      c.once('error', (e) => {
        if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
          return reject(new Error(
            'CortexInsight is not running on this machine.\n'
            + '  start it with:   cortex start\n'
            + '  or see why not:  cortex logs',
          ));
        }
        if (e.code === 'EACCES') {
          return reject(new Error('this account is not allowed to reach the console. It runs as the user who installed it.'));
        }
        reject(e);
      });
      c.on('data', (chunk) => {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          if (!line.trim()) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.push) { if (this.onPush) this.onPush(m.push); continue; }
          const w = this.waiting.get(m.id);
          if (w) { this.waiting.delete(m.id); w(m); }
        }
      });
      c.on('close', () => {
        for (const [, w] of this.waiting) w({ ok: false, error: 'the console closed the connection' });
        this.waiting.clear();
        this.conn = null;
      });
    });
  }

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error('not connected'));
      const id = ++this.seq;
      this.waiting.set(id, (m) => (m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error), { channels: m.channels }))));
      this.conn.write(JSON.stringify({ id, ...msg }) + '\n');
    });
  }

  hello() { return this.send({ op: 'hello' }); }
  channels() { return this.send({ op: 'channels' }); }
  invoke(channel, ...args) { return this.send({ op: 'invoke', channel, args }); }
  subscribe(replay) { return this.send({ op: 'subscribe', replay: replay || 0 }); }
  close() { if (this.conn) this.conn.end(); }
}

async function open(sock) { return await new Client(sock).connect(); }

module.exports = { Client, open, defaultSocket };
