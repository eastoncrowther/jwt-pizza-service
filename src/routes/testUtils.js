const request = require('supertest');
const app = require('../service');

function randomEmail() {
  return Math.random().toString(36).substring(2, 12) + '@test.com';
}

async function registerDiner(overrides = {}) {
  const user = { name: 'pizza diner', email: randomEmail(), password: 'a', ...overrides };
  const res = await request(app).post('/api/auth').send(user);
  return { user, token: res.body.token, id: res.body.user.id };
}

async function loginAdmin() {
  const res = await request(app).put('/api/auth').send({ email: 'a@jwt.com', password: 'admin' });
  return { token: res.body.token, id: res.body.user.id };
}

module.exports = { randomEmail, registerDiner, loginAdmin };
