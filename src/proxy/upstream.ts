import { ChatCompletionRequest } from '../types/index.js';
import { IncomingHttpHeaders } from 'node:http';

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  rawJson?: any;
}

export class UpstreamClient {
  private upstreamUrl: string;
  private defaultApiKey?: string;

  constructor(upstreamUrl: string, defaultApiKey?: string) {
    this.upstreamUrl = upstreamUrl.replace(/\/+$/, '');
    this.defaultApiKey = defaultApiKey;
  }

  public async forwardRequest(
    endpointPath: string,
    method: string,
    headers: IncomingHttpHeaders,
    body?: ChatCompletionRequest | string
  ): Promise<Response> {
    const targetUrl = `${this.upstreamUrl}${endpointPath.startsWith('/') ? endpointPath : '/' + endpointPath}`;

    const forwardHeaders = new Headers();
    // Copy relevant headers
    for (const [key, val] of Object.entries(headers)) {
      if (!val) continue;
      const lower = key.toLowerCase();
      // Skip hop-by-hop and client transport headers
      if (['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'expect', 'accept-encoding'].includes(lower)) {
        continue;
      }
      if (Array.isArray(val)) {
        for (const v of val) forwardHeaders.append(key, v);
      } else {
        forwardHeaders.set(key, val);
      }
    }

    // Default API key fallback if client did not supply one
    if (!forwardHeaders.has('authorization') && this.defaultApiKey) {
      forwardHeaders.set('authorization', `Bearer ${this.defaultApiKey}`);
    }

    const requestBody = typeof body === 'object' ? JSON.stringify(body) : body;

    const response = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body: requestBody,
    });

    return response;
  }
}
