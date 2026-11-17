const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');

// Carries the current Express request through async calls so that database and
// factory logs can report the authenticated user without changing any signatures.
const requestContext = new AsyncLocalStorage();

const REDACTED = '*****';
const SENSITIVE_KEY = /pass(word)?|token|jwt|secret|api[-_]?key|authorization|cookie/i;
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER_PATTERN = /(bearer\s+)[^\s"',]+/gi;

class Logger {
  constructor(loggingConfig = config.logging) {
    this.config = loggingConfig;
  }

  get enabled() {
    return /^https?:\/\//.test(this.config?.endpointUrl ?? '') && !!this.config?.apiKey && process.env.NODE_ENV !== 'test';
  }

  // ---- Express middleware ----

  // Logs every HTTP request with its method, path, status, auth header presence,
  // user, request body, and response body. Install after express.json().
  httpLogger = (req, res, next) => {
    let resBody;
    const send = res.send;
    res.send = (body) => {
      // res.json() calls res.send() again with a string, so only capture the first call.
      if (resBody === undefined) resBody = body;
      res.send = send;
      return res.send(body);
    };

    res.on('finish', () => {
      const level = this.statusToLogLevel(res.statusCode);
      this.log(level, 'http', {
        authorized: !!req.headers.authorization,
        user: this.userInfo(req.user),
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        reqBody: req.body,
        resBody,
      });
    });

    requestContext.run({ req }, next);
  };

  // Express error handler: logs the error, then hands it to the next error handler.
  errorLogger = (err, req, res, next) => {
    this.unhandledErrorLogger(err, req);
    next(err);
  };

  // ---- Logging hooks used by the application ----

  dbLogger(sql) {
    this.log('info', 'db', { user: this.currentUser(), sql });
  }

  factoryLogger({ url, method, statusCode, reqBody, resBody }) {
    const level = statusCode >= 200 && statusCode < 300 ? 'info' : 'error';
    this.log(level, 'factory', { user: this.currentUser(), url, method, statusCode, reqBody, resBody });
  }

  unhandledErrorLogger(err, req = requestContext.getStore()?.req) {
    return this.log('error', 'unhandledError', {
      user: this.userInfo(req?.user),
      method: req?.method,
      path: req?.originalUrl,
      statusCode: err?.statusCode ?? 500,
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
  }

  // ---- Core ----

  log(level, type, logData) {
    const labels = { component: this.config?.source ?? 'jwt-pizza-service', level, type };
    const values = [this.nowString(), JSON.stringify(this.sanitize(logData))];
    return this.sendLogToGrafana({ streams: [{ stream: labels, values: [values] }] });
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return (BigInt(Date.now()) * 1000000n).toString();
  }

  currentUser() {
    return this.userInfo(requestContext.getStore()?.req?.user);
  }

  userInfo(user) {
    return user ? { id: user.id, name: user.name } : null;
  }

  // Returns a copy of the data with confidential values removed.
  sanitize(data) {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed !== null && typeof parsed === 'object') return this.sanitize(parsed);
      } catch {
        // Not JSON; scrub it as plain text.
      }
      return data.replace(JWT_PATTERN, REDACTED).replace(BEARER_PATTERN, `$1${REDACTED}`);
    }
    if (Buffer.isBuffer(data)) return '[binary]';
    if (Array.isArray(data)) return data.map((item) => this.sanitize(item));
    if (data !== null && typeof data === 'object') {
      const clean = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'function') continue;
        clean[key] = SENSITIVE_KEY.test(key) && value != null ? REDACTED : this.sanitize(value);
      }
      return clean;
    }
    return data;
  }

  async sendLogToGrafana(event) {
    if (!this.enabled) return;
    try {
      const res = await fetch(this.config.endpointUrl, {
        method: 'POST',
        body: JSON.stringify(event),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.accountId}:${this.config.apiKey}`,
        },
      });
      if (!res.ok) console.error(`Failed to send log to Grafana: ${res.status}`);
    } catch (error) {
      console.error('Error sending log to Grafana:', error.message);
    }
  }
}

module.exports = new Logger();
module.exports.Logger = Logger;
