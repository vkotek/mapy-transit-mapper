import { BRIDGE_CHANNEL, BridgeNetworkMessage } from '../shared/types';

(() => {
  // Buffer captures that occur at document_start before the ISOLATED script mounts
  let overlayReady = false;
  const pendingCaptures: BridgeNetworkMessage[] = [];
  const MAX_BUFFER = 50;

  function detectEndpoint(url: string): 'jrpoifrpc' | 'poiagg' | null {
    if (url.includes('/api/jrpoifrpc')) return 'jrpoifrpc';
    if (/\/api\/poiagg($|[/?])/.test(url)) return 'poiagg';
    return null;
  }

  function bufferToBase64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function postUrlChange(): void {
    window.postMessage(
      {
        channel: BRIDGE_CHANNEL,
        type: 'URL_CHANGE',
        url: window.location.href,
      },
      window.location.origin
    );
  }

  function postNetworkCapture(
    endpoint: 'jrpoifrpc' | 'poiagg',
    url: string,
    requestBase64: string | null,
    responseBase64: string,
    contentType: string
  ): void {
    const msg: BridgeNetworkMessage = {
      channel: BRIDGE_CHANNEL,
      type: 'NETWORK_CAPTURE',
      endpoint,
      url,
      requestBase64,
      responseBase64,
      contentType,
    };

    if (!overlayReady) {
      pendingCaptures.push(msg);
      if (pendingCaptures.length > MAX_BUFFER) {
        pendingCaptures.shift();
      }
      return;
    }

    window.postMessage(msg, window.location.origin);
  }

  // Listen for ISOLATED overlay readiness and flush buffered early captures
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as { channel?: string; type?: string } | undefined;
    if (data?.channel === BRIDGE_CHANNEL && data.type === 'BRIDGE_READY') {
      overlayReady = true;
      postUrlChange();
      while (pendingCaptures.length > 0) {
        const msg = pendingCaptures.shift();
        if (msg) window.postMessage(msg, window.location.origin);
      }
    }
  });

  // 1. Hook History API so URL/viewport/stop changes arrive immediately
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  history.pushState = function patchedPushState(...args: Parameters<History['pushState']>) {
    const result = origPushState(...args);
    postUrlChange();
    return result;
  };

  history.replaceState = function patchedReplaceState(...args: Parameters<History['replaceState']>) {
    const result = origReplaceState(...args);
    postUrlChange();
    return result;
  };

  window.addEventListener('popstate', postUrlChange);
  window.addEventListener('hashchange', postUrlChange);

  // 2. Non-destructively tap window.fetch
  const origFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const endpoint = detectEndpoint(url);

    let reqBase64: string | null = null;
    if (endpoint) {
      try {
        const body = init?.body;
        if (body instanceof ArrayBuffer) {
          reqBase64 = bufferToBase64(body);
        } else if (ArrayBuffer.isView(body)) {
          reqBase64 = bufferToBase64(
            new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          );
        } else if (typeof body === 'string') {
          reqBase64 = bufferToBase64(new TextEncoder().encode(body));
        } else if (body instanceof Blob) {
          reqBase64 = bufferToBase64(await body.arrayBuffer());
        } else if (input instanceof Request) {
          const clonedReq = input.clone();
          const buf = await clonedReq.arrayBuffer();
          if (buf.byteLength > 0) reqBase64 = bufferToBase64(buf);
        }
      } catch {
        reqBase64 = null;
      }
    }

    const response = await origFetch(input, init);

    if (endpoint && response.ok) {
      try {
        const cloned = response.clone();
        const contentType = cloned.headers.get('content-type') || '';
        const respBuf = await cloned.arrayBuffer();
        postNetworkCapture(endpoint, url, reqBase64, bufferToBase64(respBuf), contentType);
      } catch {
        // Never break host page fetch
      }
    }

    return response;
  };

  // 3. Non-destructively tap XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  interface TrackedXhr extends XMLHttpRequest {
    __mtmUrl?: string;
    __mtmEndpoint?: 'jrpoifrpc' | 'poiagg' | null;
    __mtmReqBase64?: string | null;
  }

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: TrackedXhr,
    method: string,
    url: string | URL,
    asyncFlag?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    const urlStr = typeof url === 'string' ? url : url.href;
    this.__mtmUrl = urlStr;
    this.__mtmEndpoint = detectEndpoint(urlStr);
    return origOpen.call(this, method, urlStr, asyncFlag ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
    this: TrackedXhr,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    if (this.__mtmEndpoint) {
      try {
        if (body instanceof ArrayBuffer) {
          this.__mtmReqBase64 = bufferToBase64(body);
        } else if (ArrayBuffer.isView(body)) {
          this.__mtmReqBase64 = bufferToBase64(
            new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          );
        } else if (typeof body === 'string') {
          this.__mtmReqBase64 = bufferToBase64(new TextEncoder().encode(body));
        }
      } catch {
        this.__mtmReqBase64 = null;
      }

      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300 || !this.__mtmEndpoint) return;
          const contentType = this.getResponseHeader('content-type') || '';
          let respBase64: string | null = null;
          if (this.response instanceof ArrayBuffer) {
            respBase64 = bufferToBase64(this.response);
          } else if (typeof this.response === 'string') {
            respBase64 = bufferToBase64(new TextEncoder().encode(this.response));
          }
          if (respBase64) {
            postNetworkCapture(
              this.__mtmEndpoint,
              this.__mtmUrl || '',
              this.__mtmReqBase64 ?? null,
              respBase64,
              contentType
            );
          }
        } catch {
          // Ignore host XHR read errors
        }
      });
    }
    return origSend.call(this, body ?? null);
  };
})();
