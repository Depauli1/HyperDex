const ProviderManager = require('../../src/utils/provider-manager');
const { expect } = require('chai');
const sinon = require('sinon');

describe('ProviderManager', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('constructor throws without rpcUrls', () => {
    expect(() => new ProviderManager()).to.throw('At least one RPC URL must be provided');
  });

  it('getProvider returns current provider', () => {
    const urls = ['url1','url2'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000 });
    expect(pm.getProvider()).to.be.equal(pm.providers[0]);
    pm.cleanup();
  });

  it('getHealthStatus returns correct structure', async () => {
    const urls = ['url1'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000 });
    // stub a healthy provider
    sinon.stub(pm.providers[0], 'getBlockNumber').resolves(100);
    await pm.initialize();
    const status = await pm.getHealthStatus();
    expect(status).to.have.property('hasHealthyProvider', true);
    expect(status.providers).to.be.an('array');
    pm.cleanup();
  });

  it('executeWithProvider returns method result', async () => {
    const urls = ['url1'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000 });
    const result = await pm.executeWithProvider(provider => Promise.resolve('ok'));
    expect(result).to.be.equal('ok');
    pm.cleanup();
  });

  it('executeWithProvider fails over to next provider', async () => {
    const urls = ['url1','url2'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000, maxRetries: 1, retryDelayMs: 0 });
    // stub providers list
    pm.providers = [ {}, {} ];
    pm.providerHealth = [{ healthy: true, errorCount: 0 }, { healthy: true, errorCount: 0 }];
    // method throws first, then succeeds
    const method = sinon.stub()
      .rejects(new Error('fail'))
      .resolves('success');
    const value = await pm.executeWithProvider(method);
    expect(value).to.be.equal('success');
    pm.cleanup();
  });
});
