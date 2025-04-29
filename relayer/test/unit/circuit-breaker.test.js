const sinon = require('sinon');
const { expect } = require('chai');
const CircuitBreaker = require('../../src/utils/circuit-breaker');
const { BigNumber } = require('ethers');

let clock;
let cb;

beforeEach(() => {
  clock = sinon.useFakeTimers();
  cb = new CircuitBreaker({
    maxGasPriceGwei: 50,
    providerFailureThreshold: 2,
    resetTimeoutMs: 100,
    halfOpenTimeMs: 50
  });
});

afterEach(() => {
  clock.restore();
});

describe('CircuitBreaker', () => {
  it('initial state is closed', () => {
    expect(cb.isClosed()).to.be.true;
    expect(cb.allowsOperations()).to.be.true;
    const status = cb.getStatus();
    expect(status.state).to.equal('closed');
  });

  it('recordProviderFailure trips open after threshold', () => {
    expect(cb.recordProviderFailure()).to.be.false;
    expect(cb.isClosed()).to.be.true;
    // second failure
    expect(cb.recordProviderFailure()).to.be.true;
    expect(cb.isClosed()).to.be.false;
  });

  it('resetProviderFailures resets count', () => {
    cb.recordProviderFailure();
    expect(cb.providerFailures).to.equal(1);
    cb.resetProviderFailures();
    expect(cb.providerFailures).to.equal(0);
  });

  it('checkGasPrice trips open when above threshold', () => {
    const priceWei = BigNumber.from('60000000000'); // 60 gwei
    expect(cb.checkGasPrice(priceWei)).to.be.true;
    expect(cb.isClosed()).to.be.false;
    const status = cb.getStatus();
    expect(status.lastGasPrice).to.be.closeTo(60, 0.0001);
  });

  it('manual open and close', () => {
    cb.open('manual');
    expect(cb.getStatus().state).to.equal('open');
    cb.close('manual');
    expect(cb.getStatus().state).to.equal('closed');
  });

  it('half-open to closed on success', () => {
    // Trip open and auto-reset to half-open
    cb._tripOpen('test');
    clock.tick(cb.options.resetTimeoutMs);
    // half-open state
    expect(cb.state).to.equal('half-open');
    cb.recordSuccess('op');
    expect(cb.isClosed()).to.be.true;
  });

  it('half-open re-opens on failure', () => {
    cb._tripOpen('test');
    clock.tick(cb.options.resetTimeoutMs);
    expect(cb.state).to.equal('half-open');
    cb.recordFailure('op', new Error('fail'));
    expect(cb.getStatus().state).to.equal('open');
  });
});
