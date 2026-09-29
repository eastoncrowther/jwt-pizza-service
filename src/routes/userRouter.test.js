const request = require('supertest');
const app = require('../service');
const { registerDiner, loginAdmin } = require('./testUtils');

test('get me unauthenticated', async () => {
  const res = await request(app).get('/api/user/me');
  expect(res.status).toBe(401);
});

test('get me authenticated', async () => {
  const { user, token } = await registerDiner();
  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.email).toBe(user.email);
});

test('update self', async () => {
  const { token, id } = await registerDiner();
  const res = await request(app)
    .put(`/api/user/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'updated name' });
  expect(res.status).toBe(200);
  expect(res.body.user.name).toBe('updated name');
  expect(res.body.token).toBeDefined();
});

test('update other user without admin', async () => {
  const { token } = await registerDiner();
  const { id: otherId } = await registerDiner();
  const res = await request(app)
    .put(`/api/user/${otherId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'hacked name' });
  expect(res.status).toBe(403);
});

test('admin updates other user', async () => {
  const { id: targetId } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  const res = await request(app)
    .put(`/api/user/${targetId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'admin updated name' });
  expect(res.status).toBe(200);
  expect(res.body.user.name).toBe('admin updated name');
});

test('admin updates nonexistent user', async () => {
  const { token: adminToken } = await loginAdmin();
  const res = await request(app)
    .put('/api/user/9999999')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'ghost' });
  expect(res.status).toBe(404);
});

test('delete user not implemented', async () => {
  const { token, id } = await registerDiner();
  const res = await request(app).delete(`/api/user/${id}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('not implemented');
});

test('list users not implemented', async () => {
  const { token } = await registerDiner();
  const res = await request(app).get('/api/user/').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('not implemented');
});
