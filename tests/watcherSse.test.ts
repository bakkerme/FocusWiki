import http, { type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHubApp, type HubAppInstance } from '../server/app.js';

interface Stream {
  response: IncomingMessage;
  text: () => string;
}

describe('live SSE events and connection bounds', () => {
  let hub: HubAppInstance;
  let server: Server;
  let base: string;
  let streams: Stream[];

  async function connect(): Promise<Stream> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/events`, (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { data += chunk; });
        const stream = { response, text: () => data };
        streams.push(stream);
        resolve(stream);
      });
      req.on('error', reject);
    });
  }

  beforeEach(async () => {
    streams = [];
    hub = createHubApp({ projects: [], enableWatcher: false, sse: { maxClients: 2, heartbeatMs: 25 } });
    server = http.createServer(hub.app);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const stream of streams) stream.response.destroy();
    await hub.close();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  });

  it('delivers the connected event, broadcasts project updates, and sends heartbeats', async () => {
    const stream = await connect();
    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers['content-type']).toBe('text/event-stream');
    await expect.poll(stream.text).toContain('"type":"connected"');
    const event = { type: 'projects:updated' as const, projectId: 'fictional', reason: 'synced' as const, at: new Date().toISOString() };
    hub.watcherHub.broadcast(event);
    await expect.poll(stream.text).toContain(`data: ${JSON.stringify(event)}\n\n`);
    await expect.poll(stream.text).toContain(': heartbeat\n\n');
    expect(hub.watcherHub.clientCount).toBe(1);
  });

  it('cleans disconnected clients and admits replacements at the configured limit', async () => {
    const first = await connect();
    await connect();
    expect(hub.watcherHub.clientCount).toBe(2);
    const rejected = await request(base).get('/api/events').expect(503);
    expect(rejected.body.error).toBe('sse_capacity');
    expect(rejected.headers['retry-after']).toBe('5');
    expect(rejected.headers['content-type']).toMatch(/application\/json/);
    first.response.destroy();
    await expect.poll(() => hub.watcherHub.clientCount).toBe(1);
    const replacement = await connect();
    await expect.poll(replacement.text).toContain('"type":"connected"');
    expect(hub.watcherHub.clientCount).toBe(2);
  });

  it('closes live sockets and clears all clients on shutdown', async () => {
    const stream = await connect();
    await expect.poll(stream.text).toContain('"type":"connected"');
    await hub.close();
    await expect.poll(() => stream.response.complete).toBe(true);
    expect(hub.watcherHub.clientCount).toBe(0);
    hub.watcherHub.broadcast({ type: 'projects:updated', reason: 'removed', at: new Date().toISOString() });
    expect(hub.watcherHub.clientCount).toBe(0);
  });
});
