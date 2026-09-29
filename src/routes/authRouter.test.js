const request = require('supertest');
const app = require('../service');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('login unknown user', async () => {
  const loginRes = await request(app).put('/api/auth').send({ email: 'nobody@test.com', password: 'wrong' });
  expect(loginRes.status).toBe(404);
});

test('login wrong password', async () => {
  const loginRes = await request(app).put('/api/auth').send({ email: testUser.email, password: 'wrongpassword' });
  expect(loginRes.status).toBe(404);
});

test('register missing fields', async () => {
  const registerRes = await request(app).post('/api/auth').send({ email: 'incomplete@test.com' });
  expect(registerRes.status).toBe(400);
});

test('register success', async () => {
  const newUser = { name: 'new diner', email: Math.random().toString(36).substring(2, 12) + '@test.com', password: 'a' };
  const registerRes = await request(app).post('/api/auth').send(newUser);
  expect(registerRes.status).toBe(200);
  expectValidJwt(registerRes.body.token);
});

test('logout', async () => {
  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${testUserAuthToken}`);
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body.message).toBe('logout successful');
});

test('logout unauthenticated', async () => {
  const logoutRes = await request(app).delete('/api/auth');
  expect(logoutRes.status).toBe(401);
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}
