const ProviderManager = require('../../src/utils/provider-manager');

describe('ProviderManager', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('constructor throws without rpcUrls', () => {
    expect(() => new ProviderManager()).toThrow('At least one RPC URL must be provided');
  });

  test('getProvider returns current provider', () => {
    const urls = ['url1','url2'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000 });
    expect(pm.getProvider()).toBe(pm.providers[0]);
    pm.cleanup();
  });

  test('getHealthStatus returns correct structure', async () => {
    const urls = ['url1'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000 });
    // stub a healthy provider
    pm.providers[0].getBlockNumber = jest.fn().mockResolvedValue(100);
    await pm.initialize();
    const status = await pm.getHealthStatus();
    expect(status).toHaveProperty('hasHealthyProvider', true);
    expect(Array.isArray(status.providers)).toBe(true);
    pm.cleanup();
  });

  test('executeWithProvider returns method result', async () => {
    const urls = ['url1'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000 });
    const result = await pm.executeWithProvider(provider => Promise.resolve('ok'));
    expect(result).toBe('ok');
    pm.cleanup();
  });

  test('executeWithProvider fails over to next provider', async () => {
    const urls = ['url1','url2'];
    const pm = new ProviderManager(urls, { healthCheckIntervalMs: 1000, maxRetries: 1, retryDelayMs: 0 });
    // stub providers list
    pm.providers = [ {}, {} ];
    pm.providerHealth = [{ healthy: true, errorCount: 0 }, { healthy: true, errorCount: 0 }];
    // method throws first, then succeeds
    const method = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('success');
    const value = await pm.executeWithProvider(method);
    expect(value).toBe('success');
    pm.cleanup();
  });
});
