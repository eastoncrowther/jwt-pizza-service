const request = require('supertest');
const app = require('../service');
const { registerDiner, loginAdmin, randomEmail } = require('./testUtils');

async function createFranchise(adminToken, admins) {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test Franchise ${randomEmail()}`, admins });
  return res.body;
}

test('list franchises anonymously', async () => {
  const res = await request(app).get('/api/franchise');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.franchises)).toBe(true);
});

test('list franchises as admin', async () => {
  const { token: adminToken } = await loginAdmin();
  const res = await request(app).get('/api/franchise').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.franchises)).toBe(true);
});

test('list franchises respects limit and pagination', async () => {
  const { token: adminToken } = await loginAdmin();
  const { user } = await registerDiner();
  const tag = Math.random().toString(36).substring(2, 12);
  for (let i = 0; i < 3; i++) {
    await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `page ${tag} ${i}`, admins: [{ email: user.email }] });
  }
  const list = (page) => request(app).get(`/api/franchise?page=${page}&limit=2&name=*${tag}*`);

  const first = await list(0);
  expect(first.status).toBe(200);
  expect(first.body.franchises.length).toBe(2);
  expect(first.body.more).toBe(true);

  const second = await list(1);
  expect(second.body.franchises.length).toBe(1);
  expect(second.body.more).toBe(false);
});

test('list franchises ignores non-numeric paging values', async () => {
  const res = await request(app).get('/api/franchise?page=abc&limit=1%20OFFSET%200');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.franchises)).toBe(true);
  expect(res.body.franchises.length).toBeLessThanOrEqual(1);
});

test('list franchises returns oldest franchises first', async () => {
  const { token: adminToken } = await loginAdmin();
  const { user } = await registerDiner();
  const tag = Math.random().toString(36).substring(2, 12);
  // Created in reverse alphabetical order so name order and id order differ
  for (const prefix of ['zulu', 'mike', 'alpha']) {
    await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `${prefix} ${tag}`, admins: [{ email: user.email }] });
  }

  const res = await request(app).get(`/api/franchise?name=*${tag}`);
  expect(res.status).toBe(200);
  expect(res.body.franchises.map((f) => f.name)).toEqual([`zulu ${tag}`, `mike ${tag}`, `alpha ${tag}`]);
});

test('create franchise requires admin', async () => {
  const { token } = await registerDiner();
  const res = await request(app).post('/api/franchise').set('Authorization', `Bearer ${token}`).send({ name: 'nope', admins: [] });
  expect(res.status).toBe(403);
});

test('create franchise as admin', async () => {
  const { user } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  const franchise = await createFranchise(adminToken, [{ email: user.email }]);
  expect(franchise.id).toBeDefined();
  expect(franchise.admins[0].email).toBe(user.email);
});

test('get user franchises for self', async () => {
  const { user, token, id } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  await createFranchise(adminToken, [{ email: user.email }]);

  const res = await request(app).get(`/api/franchise/${id}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
});

test('get user franchises as admin for other user', async () => {
  const { user, id } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  await createFranchise(adminToken, [{ email: user.email }]);

  const res = await request(app).get(`/api/franchise/${id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
});

test('get user franchises unauthorized for other user', async () => {
  const { id: targetId } = await registerDiner();
  const { token: requesterToken } = await registerDiner();

  const res = await request(app).get(`/api/franchise/${targetId}`).set('Authorization', `Bearer ${requesterToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

test('franchisee can create and delete a store', async () => {
  const { user } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  const franchise = await createFranchise(adminToken, [{ email: user.email }]);

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: 'a' });
  const franchiseeToken = loginRes.body.token;

  const storeRes = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${franchiseeToken}`)
    .send({ franchiseId: franchise.id, name: 'Test Store' });
  expect(storeRes.status).toBe(200);
  expect(storeRes.body.name).toBe('Test Store');

  const deleteStoreRes = await request(app)
    .delete(`/api/franchise/${franchise.id}/store/${storeRes.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(deleteStoreRes.status).toBe(200);
  expect(deleteStoreRes.body.message).toBe('store deleted');
});

test('create store forbidden for unrelated diner', async () => {
  const { user } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  const franchise = await createFranchise(adminToken, [{ email: user.email }]);

  const { token: unrelatedToken } = await registerDiner();
  const res = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${unrelatedToken}`)
    .send({ franchiseId: franchise.id, name: 'Should Not Exist' });
  expect(res.status).toBe(403);
});

test('delete franchise as admin', async () => {
  const { user } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  const franchise = await createFranchise(adminToken, [{ email: user.email }]);

  const res = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('franchise deleted');
});
