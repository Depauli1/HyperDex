// ignition/modules/HyperDex.js
//
// Hardhat Ignition deployment for the HyperDex stack.
//
// Ignition records each deployment so a re-run resumes instead of redeploying;
// the values that differ per network (the Uniswap v3 registry this factory
// wraps, the tokens, the Chainlink feed) are module parameters:
//
//   npx hardhat ignition deploy ignition/modules/HyperDex.js --network sepolia \
//     --parameters ignition/parameters.sepolia.json
//
// Deploys HyperDexFactory, BridgeRouter, FeeController and the HyperDex gasless
// gateway, and links the factory to the fee controller. Ownership stays with
// the deployer: transferring it is a deliberate, separate step.
//
// One wiring step cannot be expressed as a contract call: HyperDexFactory must
// be made the owner of the Uniswap v3 factory (`v3Factory.setOwner(factory)`)
// so it can enable fee tiers. Do that after deploying, from the account that
// currently owns the Uniswap v3 factory.
const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("HyperDexModule", (m) => {
  const v3Factory = m.getParameter("v3Factory");
  const chainlinkFeed = m.getParameter("chainlinkFeed");
  const baseDenominator = m.getParameter("baseDenominator", 10);
  const minDenominator = m.getParameter("minDenominator", 4);

  const factory = m.contract("HyperDexFactory", [v3Factory]);
  const router = m.contract("BridgeRouter", []);
  const feeController = m.contract("FeeController", [
    chainlinkFeed,
    baseDenominator,
    minDenominator
  ]);
  const hyperDex = m.contract("HyperDex", [factory]);

  // The factory asks the controller for the denominator before every update;
  // without this link the protocol fee never follows the price feed.
  m.call(factory, "setFeeController", [feeController], { id: "wireFeeController" });

  return { factory, router, feeController, hyperDex };
});
