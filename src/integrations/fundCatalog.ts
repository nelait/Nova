import type { HttpResponse, MockHandler } from './client.ts';

/**
 * Mock fund catalog (see config/integrations/fund-catalog.json): tells the hub
 * whether each fund is available on the platform. Sample data for demos and
 * tests only, not real fund information. The tickers starting with X are
 * fictional funds used to show closed or restricted cases.
 */
const CATALOG: Record<string, { name: string; available: boolean; restriction?: string; shareClass: string }> = {
  VFIAX: { name: 'Vanguard 500 Index Admiral', available: true, shareClass: 'Admiral' },
  VBTLX: { name: 'Vanguard Total Bond Market Index Admiral', available: true, shareClass: 'Admiral' },
  VTIAX: { name: 'Vanguard Total International Stock Index Admiral', available: true, shareClass: 'Admiral' },
  VTTSX: { name: 'Vanguard Target Retirement 2060', available: true, shareClass: 'Investor' },
  VTTHX: { name: 'Vanguard Target Retirement 2035', available: true, shareClass: 'Investor' },
  FXAIX: { name: 'Fidelity 500 Index', available: true, shareClass: 'Institutional' },
  FXNAX: { name: 'Fidelity U.S. Bond Index', available: true, shareClass: 'Institutional' },
  FSPSX: { name: 'Fidelity International Index', available: true, shareClass: 'Institutional' },
  FTIHX: { name: 'Fidelity Total International Index', available: true, shareClass: 'Institutional' },
  FDEWX: { name: 'Fidelity Freedom 2055', available: true, shareClass: 'Investor' },
  XCLSX: { name: 'Example Closed Growth Fund (fictional)', available: false, restriction: 'Closed to new plans', shareClass: 'Retail' },
  XRSTX: { name: 'Example Restricted Income Fund (fictional)', available: false, restriction: 'Retail share class not allowed in 401(k) plans', shareClass: 'Retail' },
};

const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body) });

export const fundCatalogHandler: MockHandler = ({ method, path, body }) => {
  if (path === '/health') return json(200, { status: 'ok' });
  if (method === 'POST' && path === '/v1/funds/lookup') {
    const tickers = ((body as { tickers?: unknown })?.tickers ?? []) as unknown[];
    if (!Array.isArray(tickers)) return json(422, { error: 'tickers must be a list' });
    const results = tickers.map(String).map((t) => (CATALOG[t] ? { ticker: t, found: true, ...CATALOG[t] } : { ticker: t, found: false, available: false }));
    return json(200, { results, asOf: '2026-11-01' });
  }
  return json(404, { error: `No route ${method} ${path}` });
};
