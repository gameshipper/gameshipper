import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Route {
  body?: string | Buffer;
  type?: string;
  status?: number;
  redirect?: string;
  /** Accept the request and never answer (for timeout tests). */
  hang?: boolean;
}

export interface TestServer {
  base: string;
  port: number;
  /** Request paths (with query) in the order they arrived. */
  hits: string[];
  /** Mutable: tests may change routes between requests. */
  routes: Record<string, Route>;
  close(): Promise<void>;
}

export async function startServer(routes: Record<string, Route>): Promise<TestServer> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    const route = routes[url];
    if (!route) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (route.hang) return;
    if (route.redirect) {
      res.writeHead(302, { location: route.redirect });
      res.end();
      return;
    }
    res.writeHead(route.status ?? 200, route.type ? { 'content-type': route.type } : {});
    res.end(route.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    hits,
    routes,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
