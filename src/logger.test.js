const express = require('express');
const request = require('supertest');
const { Logger } = require('./logger');

const loggingConfig = { source: 'test-source', endpointUrl: 'https://logs.example.com/loki/api/v1/push', accountId: '123', apiKey: 'glc_abc' };

function capturingLogger() {
  const logger = new Logger(loggingConfig);
  const events = [];
  logger.sendLogToGrafana = jest.fn(async (event) => events.push(event));
  const entries = () =>
    events.map((e) => {
      const stream = e.streams[0];
      return { labels: stream.stream, data: JSON.parse(stream.values[0][1]), ts: stream.values[0][0] };
    });
  return { logger, entries };
}

describe('sanitize', () => {
  const logger = new Logger(loggingConfig);

  test('redacts sensitive keys deeply', () => {
    const clean = logger.sanitize({ email: 'a@jwt.com', password: 'secret', nested: { token: 't', jwt: 'j', apiKey: 'k' }, list: [{ Authorization: 'x' }] });
    expect(clean).toEqual({ email: 'a@jwt.com', password: '*****', nested: { token: '*****', jwt: '*****', apiKey: '*****' }, list: [{ Authorization: '*****' }] });
  });

  test('parses and sanitizes JSON strings', () => {
    expect(logger.sanitize('{"token":"abc","name":"pizza"}')).toEqual({ token: '*****', name: 'pizza' });
  });

  test('scrubs JWTs and bearer tokens from plain strings', () => {
    const text = 'Bearer abc.def got eyJhbGciOi.eyJpZCI6MX0.c2lnbmF0dXJl';
    expect(logger.sanitize(text)).toBe('Bearer ***** got *****');
  });

  test('leaves primitives, nulls and drops functions', () => {
    expect(logger.sanitize(5)).toBe(5);
    expect(logger.sanitize(null)).toBeNull();
    expect(logger.sanitize({ password: null, fn: () => 1 })).toEqual({ password: null });
    expect(logger.sanitize(Buffer.from('x'))).toBe('[binary]');
    expect(logger.sanitize('"just a string"')).toBe('"just a string"');
  });
});

test('statusToLogLevel', () => {
  const logger = new Logger(loggingConfig);
  expect(logger.statusToLogLevel(200)).toBe('info');
  expect(logger.statusToLogLevel(404)).toBe('warn');
  expect(logger.statusToLogLevel(500)).toBe('error');
});

test('httpLogger logs request, response, user and propagates user to db logs', async () => {
  const { logger, entries } = capturingLogger();
  const app = express();
  app.use(express.json());
  app.use(logger.httpLogger);
  app.use((req, res, next) => {
    req.user = { id: 7, name: 'pizza diner', email: 'd@jwt.com' };
    next();
  });
  app.put('/api/auth', async (req, res) => {
    await Promise.resolve();
    logger.dbLogger('SELECT * FROM user WHERE email=?');
    res.json({ user: { id: 7 }, token: 'secret-token' });
  });

  const res = await request(app).put('/api/auth').set('Authorization', 'Bearer abc').send({ email: 'd@jwt.com', password: 'diner' });
  expect(res.status).toBe(200);

  const [db, http] = entries();
  expect(db.labels).toEqual({ component: 'test-source', level: 'info', type: 'db' });
  expect(db.data).toEqual({ user: { id: 7, name: 'pizza diner' }, sql: 'SELECT * FROM user WHERE email=?' });

  expect(http.labels.type).toBe('http');
  expect(http.ts).toMatch(/^\d+$/);
  expect(http.data).toEqual({
    authorized: true,
    user: { id: 7, name: 'pizza diner' },
    method: 'PUT',
    path: '/api/auth',
    statusCode: 200,
    reqBody: { email: 'd@jwt.com', password: '*****' },
    resBody: { user: { id: 7 }, token: '*****' },
  });
});

test('errorLogger logs unhandled errors and passes them on', async () => {
  const { logger, entries } = capturingLogger();
  const app = express();
  app.use(logger.httpLogger);
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.use(logger.errorLogger);
  app.use((err, req, res, next) => {
    res.status(500).json({ message: err.message });
    next();
  });

  const res = await request(app).get('/boom');
  expect(res.status).toBe(500);

  const [error, http] = entries();
  expect(error.labels).toMatchObject({ level: 'error', type: 'unhandledError' });
  expect(error.data).toMatchObject({ user: null, method: 'GET', path: '/boom', statusCode: 500, message: 'kaboom' });
  expect(http.labels).toMatchObject({ level: 'error', type: 'http' });
  expect(http.data.authorized).toBe(false);
});

test('factoryLogger and unhandledErrorLogger outside a request', () => {
  const { logger, entries } = capturingLogger();
  logger.factoryLogger({ url: 'u', method: 'POST', statusCode: 200, reqBody: { diner: { id: 1 } }, resBody: { jwt: 'abc', reportUrl: 'r' } });
  logger.factoryLogger({ url: 'u', method: 'POST', statusCode: 500, reqBody: {}, resBody: {} });
  logger.unhandledErrorLogger('plain failure');

  const [ok, failed, error] = entries();
  expect(ok.labels).toMatchObject({ level: 'info', type: 'factory' });
  expect(ok.data).toEqual({ user: null, url: 'u', method: 'POST', statusCode: 200, reqBody: { diner: { id: 1 } }, resBody: { jwt: '*****', reportUrl: 'r' } });
  expect(failed.labels.level).toBe('error');
  expect(error.data).toMatchObject({ message: 'plain failure', statusCode: 500, user: null });
});

describe('sendLogToGrafana', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalEnv;
  });

  test('does nothing when disabled', async () => {
    global.fetch = jest.fn();
    await new Logger(loggingConfig).sendLogToGrafana({});
    await new Logger({ endpointUrl: 'REPLACE_ME', apiKey: 'x' }).sendLogToGrafana({});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('posts to Loki with credentials and reports failures', async () => {
    process.env.NODE_ENV = 'production';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger(loggingConfig);

    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    await logger.sendLogToGrafana({ streams: [] });
    expect(global.fetch).toHaveBeenCalledWith(loggingConfig.endpointUrl, expect.objectContaining({ method: 'POST', body: '{"streams":[]}' }));
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer 123:glc_abc');
    expect(errorSpy).not.toHaveBeenCalled();

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    await logger.sendLogToGrafana({});
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await logger.sendLogToGrafana({});
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
