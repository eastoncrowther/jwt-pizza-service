const request = require('supertest');
const app = require('./service');

test('welcome message', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('welcome to JWT Pizza');
  expect(res.body.version).toBeDefined();
});

test('docs', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  expect(res.body.version).toBeDefined();
  expect(Array.isArray(res.body.endpoints)).toBe(true);
  expect(res.body.endpoints.length).toBeGreaterThan(0);
});

test('unknown endpoint', async () => {
  const res = await request(app).get('/api/nonexistent');
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown endpoint');
});
