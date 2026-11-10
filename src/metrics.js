const os = require('os');
const config = require('./config.js');

const REPORT_PERIOD_MS = 10000;
const ACTIVE_USER_TIMEOUT_MS = 10 * 60 * 1000;

// ---- In-memory metric state ----
// Counters are cumulative since process start (Grafana uses rate() to get per-minute values).
const httpRequests = { total: 0, GET: 0, PUT: 0, POST: 0, DELETE: 0 };
const auth = { success: 0, failure: 0 };
const pizza = { sold: 0, creationFailures: 0, revenue: 0 };
// Latency is reported as the average over each reporting period, then reset.
const latency = {
  service: { totalMs: 0, count: 0 },
  pizzaCreation: { totalMs: 0, count: 0 },
};
// userId -> last time the user was seen (logged in or made an authenticated request)
const activeUsers = new Map();

// ---- Recording functions ----

// Express middleware: counts requests by method, records service latency,
// tracks authentication attempts, and keeps active users fresh.
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    httpRequests.total++;
    if (req.method in httpRequests) {
      httpRequests[req.method]++;
    }

    recordLatency(latency.service, start);

    const path = req.originalUrl.split('?')[0];
    if (path === '/api/auth' && req.method === 'PUT') {
      authAttempt(res.statusCode === 200);
    }

    if (req.user && res.statusCode < 400) {
      activeUsers.set(req.user.id, Date.now());
    }
  });
  next();
}

function authAttempt(success) {
  if (success) {
    auth.success++;
  } else {
    auth.failure++;
  }
}

function userLoggedIn(userId) {
  activeUsers.set(userId, Date.now());
}

function userLoggedOut(userId) {
  activeUsers.delete(userId);
}

// Called after the pizza factory responds to an order.
function pizzaPurchase(success, latencyMs, order) {
  latency.pizzaCreation.totalMs += latencyMs;
  latency.pizzaCreation.count++;
  if (success) {
    const items = order?.items ?? [];
    pizza.sold += items.length;
    pizza.revenue += items.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  } else {
    pizza.creationFailures++;
  }
}

function recordLatency(bucket, startNs) {
  bucket.totalMs += Number(process.hrtime.bigint() - startNs) / 1e6;
  bucket.count++;
}

// ---- System metrics ----

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();
  return Number(((usedMemory / totalMemory) * 100).toFixed(2));
}

function getActiveUserCount(now = Date.now()) {
  for (const [userId, lastSeen] of activeUsers) {
    if (now - lastSeen > ACTIVE_USER_TIMEOUT_MS) {
      activeUsers.delete(userId);
    }
  }
  return activeUsers.size;
}

// ---- OTel metric building ----

class OtelMetricBuilder {
  constructor(source) {
    this.source = source;
    this.metrics = [];
    this.timeUnixNano = String(Date.now() * 1000000);
  }

  sum(name, value, unit, attributes = {}) {
    return this.add(name, value, unit, 'sum', attributes);
  }

  gauge(name, value, unit, attributes = {}) {
    return this.add(name, value, unit, 'gauge', attributes);
  }

  add(name, value, unit, type, attributes) {
    const dataPoint = {
      [Number.isInteger(value) ? 'asInt' : 'asDouble']: value,
      timeUnixNano: this.timeUnixNano,
      attributes: Object.entries({ ...attributes, source: this.source }).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
    };
    const metric = { name, unit, [type]: { dataPoints: [dataPoint] } };
    if (type === 'sum') {
      metric.sum.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
      metric.sum.isMonotonic = true;
    }
    this.metrics.push(metric);
    return this;
  }

  toJSON() {
    return { resourceMetrics: [{ scopeMetrics: [{ metrics: this.metrics }] }] };
  }
}

function buildMetrics(source) {
  const builder = new OtelMetricBuilder(source);

  // HTTP requests
  for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
    builder.sum('http_requests', httpRequests[method], '1', { method });
  }
  builder.sum('http_requests', httpRequests.total, '1', { method: 'ALL' });

  // Users and authentication
  builder.gauge('active_users', getActiveUserCount(), '{user}');
  builder.sum('auth_attempts', auth.success, '1', { status: 'success' });
  builder.sum('auth_attempts', auth.failure, '1', { status: 'failure' });

  // System
  builder.gauge('cpu', getCpuUsagePercentage(), '%');
  builder.gauge('memory', getMemoryUsagePercentage(), '%');

  // Pizza purchases
  builder.sum('pizzas_sold', pizza.sold, '1');
  builder.sum('pizza_creation_failures', pizza.creationFailures, '1');
  builder.sum('pizza_revenue', pizza.revenue, '1');

  // Latency: average over the period (only when something happened)
  for (const [name, bucket] of Object.entries({ service_latency: latency.service, pizza_creation_latency: latency.pizzaCreation })) {
    if (bucket.count > 0) {
      builder.gauge(name, bucket.totalMs / bucket.count, 'ms');
    }
    bucket.totalMs = 0;
    bucket.count = 0;
  }

  return builder;
}

async function sendMetricsToGrafana(builder, metricsConfig = config.metrics) {
  const body = JSON.stringify(builder.toJSON());
  try {
    const response = await fetch(metricsConfig.endpointUrl, {
      method: 'POST',
      body,
      headers: { Authorization: `Bearer ${metricsConfig.accountId}:${metricsConfig.apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      console.error(`Failed to push metrics to Grafana: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error('Error pushing metrics:', error.message);
  }
}

function sendMetricsPeriodically(period = REPORT_PERIOD_MS) {
  const timer = setInterval(() => {
    try {
      sendMetricsToGrafana(buildMetrics(config.metrics.source));
    } catch (error) {
      console.error('Error sending metrics', error);
    }
  }, period);
  timer.unref();
  return timer;
}

// Only report when Grafana is configured, and never from unit tests.
if (config.metrics?.endpointUrl && process.env.NODE_ENV !== 'test') {
  sendMetricsPeriodically();
}

module.exports = {
  requestTracker,
  authAttempt,
  userLoggedIn,
  userLoggedOut,
  pizzaPurchase,
  buildMetrics,
  sendMetricsToGrafana,
  sendMetricsPeriodically,
  OtelMetricBuilder,
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
};
