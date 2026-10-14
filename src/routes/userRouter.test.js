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

test('update email and password then log in with new credentials', async () => {
  const { user, token, id } = await registerDiner();
  const newEmail = `new${user.email}`;
  const res = await request(app)
    .put(`/api/user/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ email: newEmail, password: 'newpass' });
  expect(res.status).toBe(200);
  expect(res.body.user.email).toBe(newEmail);
  expect(res.body.user.password).toBeUndefined();

  const oldLogin = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(oldLogin.status).toBe(404);
  const newLogin = await request(app).put('/api/auth').send({ email: newEmail, password: 'newpass' });
  expect(newLogin.status).toBe(200);
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

test('list users unauthorized', async () => {
  const res = await request(app).get('/api/user');
  expect(res.status).toBe(401);
});

test('list users as diner is forbidden', async () => {
  const { token } = await registerDiner();
  const res = await request(app).get('/api/user').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

test('list users as admin', async () => {
  const { user } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  const res = await request(app).get(`/api/user?name=${user.email}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.more).toBe(false);
  expect(res.body.users).toEqual([]); // name filter does not match an email
});

test('list users returns name, email, and roles without passwords', async () => {
  const name = `list ${Math.random().toString(36).substring(2, 12)}`;
  const { user, id } = await registerDiner({ name });
  const { token: adminToken } = await loginAdmin();
  const res = await request(app).get(`/api/user?name=${encodeURIComponent(name)}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.users).toEqual([{ id, name, email: user.email, roles: [{ role: 'diner' }] }]);
});

test('list users filters by name with wildcards', async () => {
  const tag = Math.random().toString(36).substring(2, 12);
  await registerDiner({ name: `alpha ${tag}` });
  await registerDiner({ name: `beta ${tag}` });
  await registerDiner({ name: `alpha other` });
  const { token: adminToken } = await loginAdmin();
  const res = await request(app).get(`/api/user?name=*${tag}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.users.map((u) => u.name).sort()).toEqual([`alpha ${tag}`, `beta ${tag}`]);
});

test('list users is paginated', async () => {
  const tag = Math.random().toString(36).substring(2, 12);
  for (let i = 0; i < 3; i++) {
    await registerDiner({ name: `page ${tag} ${i}` });
  }
  const { token: adminToken } = await loginAdmin();
  const list = (page) => request(app).get(`/api/user?page=${page}&limit=2&name=*${tag}*`).set('Authorization', `Bearer ${adminToken}`);

  const first = await list(0);
  expect(first.status).toBe(200);
  expect(first.body.users.length).toBe(2);
  expect(first.body.more).toBe(true);

  const second = await list(1);
  expect(second.body.users.length).toBe(1);
  expect(second.body.more).toBe(false);

  const names = [...first.body.users, ...second.body.users].map((u) => u.name).sort();
  expect(names).toEqual([`page ${tag} 0`, `page ${tag} 1`, `page ${tag} 2`]);
});

test('list users defaults to all users', async () => {
  const { token: adminToken } = await loginAdmin();
  const res = await request(app).get('/api/user').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.users.length).toBeGreaterThan(0);
  expect(res.body.users.length).toBeLessThanOrEqual(10);
});

test('delete user unauthorized', async () => {
  const { id } = await registerDiner();
  const res = await request(app).delete(`/api/user/${id}`);
  expect(res.status).toBe(401);
});

test('delete user as diner is forbidden', async () => {
  const { token, id } = await registerDiner();
  const res = await request(app).delete(`/api/user/${id}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

test('admin deletes user', async () => {
  const name = `delete ${Math.random().toString(36).substring(2, 12)}`;
  const { user, id } = await registerDiner({ name });
  const { token: adminToken } = await loginAdmin();

  const res = await request(app).delete(`/api/user/${id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);

  const listRes = await request(app).get(`/api/user?name=${encodeURIComponent(name)}`).set('Authorization', `Bearer ${adminToken}`);
  expect(listRes.body.users).toEqual([]);

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(loginRes.status).toBe(404);
});

test('deleted user token no longer works', async () => {
  const { token, id } = await registerDiner();
  const { token: adminToken } = await loginAdmin();
  await request(app).delete(`/api/user/${id}`).set('Authorization', `Bearer ${adminToken}`);

  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(401);
});

test('admin deletes nonexistent user', async () => {
  const { token: adminToken } = await loginAdmin();
  const res = await request(app).delete('/api/user/9999999').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});
