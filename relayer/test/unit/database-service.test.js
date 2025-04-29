const { expect } = require('chai');
const DatabaseService = require('../../src/services/database');
const sinon = require('sinon');

describe('DatabaseService', () => {
  let ds;

  beforeEach(() => {
    ds = new DatabaseService();
    // Skip actual DB initialization
    ds.initialized = true;
    ds.models = {
      Transaction: {
        create: sinon.stub(),
        count: sinon.stub()
      },
      GasPriceHistory: {
        create: sinon.stub()
      }
    };
  });

  it('should create transaction and return created transaction', async () => {
    const txn = { id: '1' };
    ds.models.Transaction.create.resolves(txn);

    const result = await ds.createTransaction(txn);
    expect(result).to.be.deep.equal(txn);
    expect(ds.models.Transaction.create.calledWith(txn)).to.be.true;
  });

  it('should throw error on create transaction failure', async () => {
    const txn = { id: '1' };
    ds.models.Transaction.create.rejects(new Error('fail'));

    try {
      await ds.createTransaction(txn);
      expect.fail('Expected error to be thrown');
    } catch (error) {
      expect(error.message).to.equal('fail');
    }
  });

  it('should record gas price and return record on success', async () => {
    const rec = { price: '100' };
    ds.models.GasPriceHistory.create.resolves(rec);

    const result = await ds.recordGasPrice({ price: '100' });
    expect(result).to.be.deep.equal(rec);
    expect(ds.models.GasPriceHistory.create.calledWith({ price: '100' })).to.be.true;
  });

  it('should return null on record gas price failure', async () => {
    ds.models.GasPriceHistory.create.rejects(new Error('fail'));

    const result = await ds.recordGasPrice({ price: '100' });
    expect(result).to.be.null;
  });

  it('should get transaction count by status and return count on success', async () => {
    ds.models.Transaction.count.resolves(5);

    const result = await ds.getTransactionCountByStatus('pending');
    expect(result).to.equal(5);
    expect(ds.models.Transaction.count.calledWith({ where: { status: 'pending' } })).to.be.true;
  });

  it('should return 0 on get transaction count by status error', async () => {
    ds.models.Transaction.count.rejects(new Error('fail'));

    const result = await ds.getTransactionCountByStatus('pending');
    expect(result).to.equal(0);
  });
});
