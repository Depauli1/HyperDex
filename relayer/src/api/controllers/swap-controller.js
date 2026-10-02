const logger = require('../../utils/logger');
const { verifyGaslessSwap, SignatureError } = require('../../utils/signature');
const { GASLESS_SWAP_TYPES, toStruct } = require('../../config/eip712');

/**
 * Controller for swap-related endpoints.
 *
 * The body carries the signed EIP-712 struct plus the signature. The relayer
 * verifies the signature before spending gas, and the contract verifies it
 * again on-chain - the relayer is never trusted with the swap's contents.
 *
 * @param {Object} services - Service dependencies
 * @returns {Object} Controller methods
 */
module.exports = function (services) {
  const { contractService, signatureUtils } = services;
  const signatureModule = signatureUtils || { verifyGaslessSwap };

  return {
    /**
     * Handles gasless swap submission.
     *
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async submitGaslessSwap(req, res) {
      const signature = req.body.signature;
      let params;
      try {
        params = toStruct(req.body);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      logger.info(`Received gasless swap request from ${params.trader}`);

      const deployment = {
        chainId: req.body.chainId || (await contractService.provider.getNetwork()).chainId,
        verifyingContract: contractService.hyperDexAddress
      };

      try {
        signatureModule.verifyGaslessSwap(params, signature, deployment);
      } catch (error) {
        if (error instanceof SignatureError || error.code) {
          logger.warn(`Rejected gasless swap from ${params.trader}: ${error.message}`);
          const status = error.code === 'DEADLINE_EXPIRED' ? 400 : 401;
          return res.status(status).json({ error: error.message, code: error.code });
        }
        throw error;
      }

      try {
        const tx = await contractService.executeGaslessSwap(params, signature);

        // The relayer API has always answered with a transaction hash; that is
        // what the client SDK waits on.
        return res.status(200).json({
          transactionHash: tx.hash,
          status: 'submitted'
        });
      } catch (error) {
        logger.error(`Error processing swap: ${error.message}`);

        // Surface contract reverts as client errors instead of 500s.
        if (/InvalidSignature/.test(error.message)) {
          return res.status(401).json({ error: 'Invalid signature' });
        }
        if (/DeadlineExpired|deadline/.test(error.message)) {
          return res.status(400).json({ error: 'Transaction deadline expired' });
        }
        if (/InvalidNonce|nonce/.test(error.message)) {
          return res.status(400).json({ error: 'Invalid nonce' });
        }
        if (/ZeroAmount|UnknownPool|InvalidRelayer|Pausable/.test(error.message)) {
          return res.status(400).json({ error: error.message });
        }
        return res.status(500).json({ error: error.message });
      }
    },

    /** Describes the exact EIP-712 payload clients must sign. */
    async describeSigningPayload(req, res) {
      try {
        const chainId = (await contractService.provider.getNetwork()).chainId;
        return res.json({
          domain: {
            name: 'HyperDex',
            version: '1',
            chainId: Number(chainId),
            verifyingContract: contractService.hyperDexAddress
          },
          types: GASLESS_SWAP_TYPES
        });
      } catch (error) {
        logger.error(`Error describing signing payload: ${error.message}`);
        return res.status(500).json({ error: error.message });
      }
    }
  };
};
