const request = require('supertest');
const app = require('../service');
const { registerDiner, loginAdmin } = require('./testUtils');

test('get menu', async () => {
  const res = await request(app).get('/api/order/menu');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('add menu item requires admin', async () => {
  const { token } = await registerDiner();
  const res = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Student', description: 'no toppings', image: 'pizza9.png', price: 0.0001 });
  expect(res.status).toBe(403);
});

test('add menu item as admin', async () => {
  const { token: adminToken } = await loginAdmin();
  const res = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: 'Student', description: 'no toppings', image: 'pizza9.png', price: 0.0001 });
  expect(res.status).toBe(200);
  expect(res.body.some((item) => item.title === 'Student')).toBe(true);
});

test('get orders for user', async () => {
  const { token } = await registerDiner();
  const res = await request(app).get('/api/order').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.orders).toEqual([]);
});

describe('create order', () => {
  const originalFetch = global.fetch;
  let menuId;

  beforeAll(async () => {
    const { token: adminToken } = await loginAdmin();
    const menuRes = await request(app)
      .put('/api/order/menu')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Order Test Pizza', description: 'for order tests', image: 'pizza.png', price: 0.001 });
    menuId = menuRes.body[menuRes.body.length - 1].id;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('factory fulfills order', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ reportUrl: 'https://factory.example/report', jwt: 'factory-jwt' }),
    });

    const { token } = await registerDiner();
    const res = await request(app)
      .post('/api/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ franchiseId: 1, storeId: 1, items: [{ menuId, description: 'Veggie', price: 0.05 }] });

    expect(res.status).toBe(200);
    expect(res.body.jwt).toBe('factory-jwt');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('factory fails to fulfill order', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ reportUrl: 'https://factory.example/report' }),
    });

    const { token } = await registerDiner();
    const res = await request(app)
      .post('/api/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ franchiseId: 1, storeId: 1, items: [{ menuId, description: 'Veggie', price: 0.05 }] });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Failed to fulfill order at factory');
  });
});
