const DatabaseService = require('../../src/services/database');

describe('DatabaseService', () => {
  let ds;

  beforeEach(() => {
    ds = new DatabaseService();
    // Skip actual DB initialization
    ds.initialized = true;
    ds.models = {
      Transaction: {
        create: jest.fn(),
        count: jest.fn()
      },
      GasPriceHistory: {
        create: jest.fn()
      }
    };
  });

  test('createTransaction returns created transaction', async () => {
    const txn = { id: '1' };
    ds.models.Transaction.create.mockResolvedValue(txn);

    await expect(ds.createTransaction(txn)).resolves.toBe(txn);
    expect(ds.models.Transaction.create).toHaveBeenCalledWith(txn);
  });

  test('createTransaction throws error on failure', async () => {
    const txn = { id: '1' };
    ds.models.Transaction.create.mockRejectedValue(new Error('fail'));

    await expect(ds.createTransaction(txn)).rejects.toThrow('fail');
  });

  test('recordGasPrice returns record on success', async () => {
    const rec = { price: '100' };
    ds.models.GasPriceHistory.create.mockResolvedValue(rec);

    await expect(ds.recordGasPrice({ price: '100' })).resolves.toBe(rec);
    expect(ds.models.GasPriceHistory.create).toHaveBeenCalledWith({ price: '100' });
  });

  test('recordGasPrice returns null on failure', async () => {
    ds.models.GasPriceHistory.create.mockRejectedValue(new Error('fail'));

    await expect(ds.recordGasPrice({ price: '100' })).resolves.toBeNull();
  });

  test('getTransactionCountByStatus returns count on success', async () => {
    ds.models.Transaction.count.mockResolvedValue(5);

    await expect(ds.getTransactionCountByStatus('pending')).resolves.toBe(5);
    expect(ds.models.Transaction.count).toHaveBeenCalledWith({ where: { status: 'pending' } });
  });

  test('getTransactionCountByStatus returns 0 on error', async () => {
    ds.models.Transaction.count.mockRejectedValue(new Error('fail'));

    await expect(ds.getTransactionCountByStatus('pending')).resolves.toBe(0);
  });
});
