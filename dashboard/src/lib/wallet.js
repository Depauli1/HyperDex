/**
 * Minimal EIP-1193 wallet client.
 *
 * The dashboard talks to whatever provider the browser injects (`window.ethereum`)
 * or to one the user passes in; there is no bundled wallet and no server-side
 * key handling. All calls are standard Ethereum JSON-RPC methods, so any
 * injected wallet (MetaMask, Rabby, Frame, ...) works.
 */

export class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/**
 * @param {Object} [options]
 * @param {Object} [options.provider] EIP-1193 provider (defaults to window.ethereum)
 * @returns {Object} client
 */
export function createWalletClient({ provider } = {}) {
  const getProvider = () => provider || (typeof window !== 'undefined' ? window.ethereum : null);

  function requireProvider() {
    const injected = getProvider();
    if (!injected) {
      throw new WalletError(
        'No Ethereum wallet detected. Install MetaMask or another EIP-1193 wallet.',
        'NO_PROVIDER'
      );
    }
    return injected;
  }

  return {
    /** True when a provider is available (used to enable the connect button). */
    isAvailable() {
      return Boolean(getProvider());
    },

    /** Requests account access and returns the selected address. */
    async connect() {
      const injected = requireProvider();
      const accounts = await injected.request({ method: 'eth_requestAccounts' });
      if (!accounts || accounts.length === 0) {
        throw new WalletError('The wallet returned no accounts', 'NO_ACCOUNTS');
      }
      return accounts[0];
    },

    /** Currently selected address, without prompting. */
    async getAccount() {
      const injected = requireProvider();
      const accounts = await injected.request({ method: 'eth_accounts' });
      return accounts && accounts.length > 0 ? accounts[0] : null;
    },

    /** Chain id as a number. */
    async getChainId() {
      const injected = requireProvider();
      const chainId = await injected.request({ method: 'eth_chainId' });
      return Number(chainId);
    },

    /** EIP-712 signature over the gasless-swap payload. */
    async signTypedData(address, typedData) {
      const injected = requireProvider();
      return injected.request({
        method: 'eth_signTypedData_v4',
        params: [
          address,
          JSON.stringify({
            types: typedData.types,
            domain: typedData.domain,
            primaryType: typedData.primaryType,
            message: typedData.message
          })
        ]
      });
    },

    /** Sends a transaction and returns its hash. */
    async sendTransaction(address, tx) {
      const injected = requireProvider();
      return injected.request({
        method: 'eth_sendTransaction',
        params: [{ from: address, ...tx }]
      });
    },

    /** Subscribes to account/chain changes. Returns an unsubscribe function. */
    on(event, handler) {
      const injected = getProvider();
      if (!injected || !injected.on) return () => {};
      injected.on(event, handler);
      return () => {
        if (injected.removeListener) injected.removeListener(event, handler);
      };
    }
  };
}
