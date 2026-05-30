function publicProtocolFor(parsedProtocol: string, currentProtocol: string): string {
  if (parsedProtocol === 'ws:' || parsedProtocol === 'wss:') {
    return currentProtocol === 'https:' ? 'wss:' : 'ws:';
  }
  if (parsedProtocol === 'http:' || parsedProtocol === 'https:') {
    return currentProtocol === 'https:' ? 'https:' : 'http:';
  }
  return parsedProtocol;
}

export function normalizeSessionUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (typeof window === 'undefined') return parsed.toString();

    const current = new URL(window.location.origin);
    // Route session traffic (the /s/{id}/… WebSocket and the HTTP base derived
    // from it) through the page's own origin so the same-origin dev/Tailscale
    // proxy handles it. The backend advertises chat_endpoint with whatever
    // host/port it knows — a loopback or the Tailscale IP, e.g.
    // ws://100.66.123.128:8080/… — which is a different origin from the page
    // (e.g. thor-host.…:5173) and gets blocked by CORS. Rewrite
    // host+port+protocol to the current origin unless it is already same-origin.
    const sameOrigin = parsed.hostname === current.hostname && parsed.port === current.port;
    if (!sameOrigin) {
      parsed.protocol = publicProtocolFor(parsed.protocol, current.protocol);
      parsed.hostname = current.hostname;
      parsed.port = current.port;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function wsUrlToHttpBase(wsUrl: string): string | null {
  try {
    const parsed = new URL(normalizeSessionUrl(wsUrl) ?? wsUrl);
    const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    const basePath = parsed.pathname.replace(/\/(api\/)?session$/, '');
    return `${protocol}//${parsed.host}${basePath}`;
  } catch {
    return null;
  }
}

export function deriveTerminalWsUrl(chatEndpoint: string | null | undefined): string | null {
  const normalizedUrl = normalizeSessionUrl(chatEndpoint);
  if (!normalizedUrl) return null;

  try {
    const parsed = new URL(normalizedUrl);
    const protocol = parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
    const prefix = parsed.pathname.replace(/\/(api\/)?session$/, '');
    return `${protocol}//${parsed.host}${prefix}/terminal/ws`;
  } catch {
    return null;
  }
}
