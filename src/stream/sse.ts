'use strict';

import type { Request, Response } from 'express';

export interface SSERegistry {
  clients: Set<Response>;
  broadcast: (obj: any) => void;
  attach: (req: Request, res: Response, initial?: any) => void;
}

// One SSE client registry: track open responses, broadcast to all, and attach a
// new client (set the event-stream headers, optionally replay an initial payload,
// and auto-remove on disconnect). The run / stats / matrix streams are all this
// same broadcast-to-a-Set pattern.
export function createSSE(): SSERegistry {
  const clients = new Set<Response>();

  const broadcast = (obj: any) => {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) { try { res.write(line); } catch (_) {} }
  };

  const attach = (req: Request, res: Response, initial?: any) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (initial !== undefined) res.write(`data: ${JSON.stringify(initial)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  };

  return { clients, broadcast, attach };
}
