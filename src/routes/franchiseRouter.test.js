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
