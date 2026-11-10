const metrics = require('./metrics');

function findMetric(builder, name, attrs = {}) {
  return builder.metrics.find((m) => {
    if (m.name !== name) return false;
    const type = m.sum ? 'sum' : 'gauge';
    const pointAttrs = Object.fromEntries(m[type].dataPoints[0].attributes.map((a) => [a.key, a.value.stringValue]));
    return Object.entries(attrs).every(([k, v]) => pointAttrs[k] === v);
  });
}

function value(metric) {
  const point = (metric.sum ?? metric.gauge).dataPoints[0];
  return point.asInt ?? point.asDouble;
}

function fakeRequest(method, url, statusCode, user) {
  const listeners = {};
  const req = { method, originalUrl: url, user };
  const res = { statusCode, on: (event, fn) => (listeners[event] = fn) };
  const next = jest.fn();
  metrics.requestTracker(req, res, next);
  expect(next).toHaveBeenCalled();
  listeners.finish();
}

test('builder creates sum and gauge metrics with source attribute', () => {
  const builder = new metrics.OtelMetricBuilder('test-source');
  builder.sum('requests', 5, '1', { method: 'GET' }).gauge('cpu', 12.5, '%');
  const json = builder.toJSON();
  const [sum, gauge] = json.resourceMetrics[0].scopeMetrics[0].metrics;

  expect(sum.sum.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
  expect(sum.sum.isMonotonic).toBe(true);
  expect(sum.sum.dataPoints[0].asInt).toBe(5);
  expect(sum.sum.dataPoints[0].attributes).toContainEqual({ key: 'source', value: { stringValue: 'test-source' } });
  expect(gauge.gauge.dataPoints[0].asDouble).toBe(12.5);
});

test('request tracker counts methods, auth attempts, latency and active users', () => {
  const before = metrics.buildMetrics('s');
  const getBefore = value(findMetric(before, 'http_requests', { method: 'GET' }));
  const totalBefore = value(findMetric(before, 'http_requests', { method: 'ALL' }));
  const authOkBefore = value(findMetric(before, 'auth_attempts', { status: 'success' }));
  const authFailBefore = value(findMetric(before, 'auth_attempts', { status: 'failure' }));

  fakeRequest('GET', '/api/order/menu?page=1', 200);
  fakeRequest('PUT', '/api/auth', 200);
  fakeRequest('PUT', '/api/auth', 404);
  fakeRequest('GET', '/api/order', 200, { id: 9999 });

  const after = metrics.buildMetrics('s');
  expect(value(findMetric(after, 'http_requests', { method: 'GET' }))).toBe(getBefore + 2);
  expect(value(findMetric(after, 'http_requests', { method: 'ALL' }))).toBe(totalBefore + 4);
  expect(value(findMetric(after, 'auth_attempts', { status: 'success' }))).toBe(authOkBefore + 1);
  expect(value(findMetric(after, 'auth_attempts', { status: 'failure' }))).toBe(authFailBefore + 1);
  expect(findMetric(after, 'service_latency')).toBeDefined();
  expect(value(findMetric(after, 'active_users'))).toBeGreaterThanOrEqual(1);

  // latency resets after each report
  expect(findMetric(metrics.buildMetrics('s'), 'service_latency')).toBeUndefined();
});

test('active users track login and logout', () => {
  const count = () => value(findMetric(metrics.buildMetrics('s'), 'active_users'));
  const start = count();
  metrics.userLoggedIn(123456);
  expect(count()).toBe(start + 1);
  metrics.userLoggedOut(123456);
  expect(count()).toBe(start);
});

test('pizza purchases record sold, revenue, failures and latency', () => {
  const before = metrics.buildMetrics('s');
  const sold = value(findMetric(before, 'pizzas_sold'));
  const failures = value(findMetric(before, 'pizza_creation_failures'));
  const revenue = value(findMetric(before, 'pizza_revenue'));

  metrics.pizzaPurchase(true, 100, { items: [{ price: 0.05 }, { price: 0.25 }] });
  metrics.pizzaPurchase(false, 300, { items: [{ price: 1 }] });

  const after = metrics.buildMetrics('s');
  expect(value(findMetric(after, 'pizzas_sold'))).toBe(sold + 2);
  expect(value(findMetric(after, 'pizza_creation_failures'))).toBe(failures + 1);
  expect(value(findMetric(after, 'pizza_revenue'))).toBeCloseTo(revenue + 0.3);
  expect(value(findMetric(after, 'pizza_creation_latency'))).toBe(200);
});

test('system metrics are percentages', () => {
  expect(metrics.getCpuUsagePercentage()).toBeGreaterThanOrEqual(0);
  const mem = metrics.getMemoryUsagePercentage();
  expect(mem).toBeGreaterThan(0);
  expect(mem).toBeLessThanOrEqual(100);
});

describe('sending metrics', () => {
  const originalFetch = global.fetch;
  const cfg = { endpointUrl: 'https://grafana.test/otlp', accountId: '123', apiKey: 'key' };
  let errorSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    errorSpy.mockRestore();
  });

  test('posts OTel JSON with auth header', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    await metrics.sendMetricsToGrafana(new metrics.OtelMetricBuilder('s').gauge('cpu', 1, '%'), cfg);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(cfg.endpointUrl);
    expect(options.headers.Authorization).toBe('Bearer 123:key');
    expect(JSON.parse(options.body).resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe('cpu');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('logs failed responses', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    await metrics.sendMetricsToGrafana(new metrics.OtelMetricBuilder('s'), cfg);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('401'));
  });

  test('logs network errors', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await metrics.sendMetricsToGrafana(new metrics.OtelMetricBuilder('s'), cfg);
    expect(errorSpy).toHaveBeenCalledWith('Error pushing metrics:', 'offline');
  });

  test('periodic sender can be started and stopped', () => {
    const timer = metrics.sendMetricsPeriodically(60000);
    expect(timer).toBeDefined();
    clearInterval(timer);
  });
});
