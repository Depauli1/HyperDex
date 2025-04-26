const request = require('supertest');
const { startServer } = require('../../src/index');

describe('Metrics Endpoint Integration Tests', () => {
  let server;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    server = await startServer();
  });

  afterAll(() => {
    if (server && server.close) server.close();
  });

  test('GET /metrics returns Prometheus metrics', async () => {
    const res = await request(server).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toMatch(/# HELP hyperdex_http_requests_total/);
  });
});
