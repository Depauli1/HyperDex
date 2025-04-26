const CircuitBreaker = require('../../src/utils/circuit-breaker');
const { BigNumber } = require('ethers');

describe('CircuitBreaker', () => {
  jest.useFakeTimers();
  let cb;

  beforeEach(() => {
    cb = new CircuitBreaker({
      maxGasPriceGwei: 50,
      providerFailureThreshold: 2,
      resetTimeoutMs: 100,
      halfOpenTimeMs: 50
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  test('initial state is closed', () => {
    expect(cb.isClosed()).toBe(true);
    expect(cb.allowsOperations()).toBe(true);
    const status = cb.getStatus();
    expect(status.state).toBe('closed');
  });

  test('recordProviderFailure trips open after threshold', () => {
    expect(cb.recordProviderFailure()).toBe(false);
    expect(cb.isClosed()).toBe(true);
    // second failure
    expect(cb.recordProviderFailure()).toBe(true);
    expect(cb.isClosed()).toBe(false);
  });

  test('resetProviderFailures resets count', () => {
    cb.recordProviderFailure();
    expect(cb.providerFailures).toBe(1);
    cb.resetProviderFailures();
    expect(cb.providerFailures).toBe(0);
  });

  test('checkGasPrice trips open when above threshold', () => {
    const priceWei = BigNumber.from('60000000000'); // 60 gwei
    expect(cb.checkGasPrice(priceWei)).toBe(true);
    expect(cb.isClosed()).toBe(false);
    const status = cb.getStatus();
    expect(status.lastGasPrice).toBeCloseTo(60);
  });

  test('manual open and close', () => {
    cb.open('manual');
    expect(cb.getStatus().state).toBe('open');
    cb.close('manual');
    expect(cb.getStatus().state).toBe('closed');
  });

  test('half-open to closed on success', () => {
    // Trip open and auto-reset to half-open
    cb._tripOpen('test');
    jest.advanceTimersByTime(cb.options.resetTimeoutMs);
    // half-open state
    expect(cb.state).toBe('half-open');
    cb.recordSuccess('op');
    expect(cb.isClosed()).toBe(true);
  });

  test('half-open re-opens on failure', () => {
    cb._tripOpen('test');
    jest.advanceTimersByTime(cb.options.resetTimeoutMs);
    expect(cb.state).toBe('half-open');
    cb.recordFailure('op', new Error('fail'));
    expect(cb.getStatus().state).toBe('open');
  });
});
