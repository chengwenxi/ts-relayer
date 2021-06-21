import http from 'http';

import client from 'prom-client';

import { Logger } from '../create-logger';

let initialized = false;

const prefix = 'relayer';
const withPrefix = (name: string) => `${prefix}_${name}`;

function getMetrics() {
  return {
    loopTotal: new client.Counter({
      name: withPrefix('loop_total'),
      help: 'Total relayer loops.',
    }),
    pendingPacketsSrc: new client.Gauge({
      name: withPrefix('pending_packets_src'),
      help: 'Total pending packages on source chain.',
    }),
    pendingPacketsDest: new client.Gauge({
      name: withPrefix('pending_packets_dest'),
      help: 'Total pending packages on destination chain.',
    }),
    errTxsTotal: new client.Counter({
      name: withPrefix('err_txs_total'),
      help: 'Total error on sending transaction.',
    }),
    balancesSrc: new client.Gauge({
      name: withPrefix('balances_src'),
      help: 'Balances on source chain.',
    }),
    balancesDest: new client.Gauge({
      name: withPrefix('balances_dest'),
      help: 'Balances on destination chain.',
    }),
  };
}

export type Metrics = {
  loopTotal: client.Counter<string>;
  pendingPacketsSrc: client.Gauge<string>;
  pendingPacketsDest: client.Gauge<string>;
  errTxsTotal: client.Counter<string>;
  balancesSrc: client.Gauge<string>;
  balancesDest: client.Gauge<string>;
} | null;

export function setupPrometheus({
  enabled,
  port,
  logger,
}: {
  enabled: boolean;
  port: number;
  logger: Logger;
}): Metrics {
  if (initialized) {
    throw new Error(
      `"setupPrometheus" func shouldn't be initialized more than once.`
    );
  }
  initialized = true;

  if (!enabled) {
    return null;
  }

  client.collectDefaultMetrics({ prefix: `${prefix}_` });
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      const metrics = await client.register.metrics();
      response.writeHead(200, {
        'Content-Type': client.register.contentType,
      });
      response.end(metrics);

      return;
    }

    response.writeHead(404);
    response.end('404');
  });
  server.listen(port);
  logger.info(`Prometheus GET /metrics exposed on port ${port}.`);

  return getMetrics();
}
