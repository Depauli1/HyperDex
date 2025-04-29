const request = require('supertest');
const { startServer } = require('../../src/index');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Metrics Endpoint Integration Tests', () => {
  let server;

  before(async () => {
    process.env.NODE_ENV = 'test';
    server = await startServer();
  });

  after(async () => {
    sinon.restore();
    if (server && server.close) server.close();
  });

  it('GET /metrics returns Prometheus metrics', async () => {
    const res = await request(server).get('/metrics');
    expect(res.status).to.equal(200);
    expect(res.headers['content-type']).to.match(/text\/plain/);
    expect(res.text).to.match(/# HELP hyperdex_http_requests_total/);
  });
});
