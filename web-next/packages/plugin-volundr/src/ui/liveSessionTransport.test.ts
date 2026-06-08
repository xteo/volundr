import { afterEach, describe, expect, it } from 'vitest';
import { deriveTerminalWsUrl, normalizeSessionUrl, wsUrlToHttpBase } from './liveSessionTransport';

// normalizeSessionUrl (and the helpers that call it) route session traffic
// through the page's own origin. Set a deterministic page origin per test so
// the same-origin passthrough vs cross-origin rewrite is unambiguous.
const originalWindow = globalThis.window;
function setOrigin(origin: string): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin } },
  });
}
afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('liveSessionTransport', () => {
  it('derives an http base from a same-origin chat websocket', () => {
    setOrigin('https://api.example.com');
    expect(wsUrlToHttpBase('wss://api.example.com/s/abc/session')).toBe(
      'https://api.example.com/s/abc',
    );
  });

  it('supports legacy api/session suffixes (same origin)', () => {
    setOrigin('http://localhost:8080');
    expect(wsUrlToHttpBase('ws://localhost:8080/s/abc/api/session')).toBe(
      'http://localhost:8080/s/abc',
    );
  });

  it('derives the terminal websocket from a same-origin chat websocket', () => {
    setOrigin('http://localhost:8080');
    expect(deriveTerminalWsUrl('ws://localhost:8080/s/abc/session')).toBe(
      'ws://localhost:8080/s/abc/terminal/ws',
    );
  });

  it('rewrites a loopback host to the page origin', () => {
    setOrigin('http://localhost:8080');
    expect(normalizeSessionUrl('ws://127.0.0.1:8080/s/abc/session')).toBe(
      'ws://localhost:8080/s/abc/session',
    );
  });

  it('rewrites a cross-origin session host to the page origin (CORS fix)', () => {
    // Backend advertises the Tailscale IP; the page is served elsewhere. The
    // session URL must be rewritten to the page origin so the same-origin proxy
    // handles it (no CORS). Protocol follows the page (http -> ws).
    setOrigin('http://thor-host.tail737f2a.ts.net:5173');
    expect(normalizeSessionUrl('ws://100.66.123.128:8080/s/abc/session')).toBe(
      'ws://thor-host.tail737f2a.ts.net:5173/s/abc/session',
    );
    // and the derived http base + terminal url follow the same origin
    expect(wsUrlToHttpBase('ws://100.66.123.128:8080/s/abc/session')).toBe(
      'http://thor-host.tail737f2a.ts.net:5173/s/abc',
    );
    expect(deriveTerminalWsUrl('ws://100.66.123.128:8080/s/abc/session')).toBe(
      'ws://thor-host.tail737f2a.ts.net:5173/s/abc/terminal/ws',
    );
  });

  it('upgrades to wss/https when the page is https', () => {
    setOrigin('https://thor-host.tail737f2a.ts.net');
    expect(normalizeSessionUrl('ws://100.66.123.128:8080/s/abc/session')).toBe(
      'wss://thor-host.tail737f2a.ts.net/s/abc/session',
    );
  });

  it('returns null for malformed urls', () => {
    expect(wsUrlToHttpBase('not-a-url')).toBeNull();
    expect(deriveTerminalWsUrl('not-a-url')).toBeNull();
  });
});
