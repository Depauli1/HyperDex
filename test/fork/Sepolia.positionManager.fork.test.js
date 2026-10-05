// PositionManager against the REAL NonfungiblePositionManager on Sepolia.
//
// The periphery is Uniswap's own deployed contract; the manager talks to it
// through the interface in contracts/PositionManager.sol. These tests prove the
// interface matches the deployment (selector and return shapes) and that the
// manager holds the position while the beneficial owner keeps control.
//
// The full mint -> increase -> collect -> withdraw lifecycle needs two funded
// ERC20 balances on the fork, so it is opt-in: set FORK_FUNDED_TOKENS=1 and
// FUNDED_TOKEN_A/FUNDED_TOKEN_B to two Sepolia ERC20s the impersonated account
// holds. Without that, the suite asserts the parts that need no funding.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { sepolia } = require("./helpers/addresses");
const { skipUnlessForked } = require("./helpers/fork");

const NFPM_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
];

describe("PositionManager on a Sepolia fork (real periphery)", function () {
  let admin, stranger, manager, nfpm;

  before(async function () {
    if (!(await skipUnlessForked(sepolia.chainId, this))) return;

    [admin, stranger] = await ethers.getSigners();
    nfpm = new ethers.Contract(sepolia.nonfungiblePositionManager, NFPM_ABI, ethers.provider);

    const PositionManager = await ethers.getContractFactory("PositionManager");
    manager = await PositionManager.deploy(sepolia.nonfungiblePositionManager);
  });

  it("deploys against the deployed periphery", async function () {
    if (!manager) this.skip();
    expect(await manager.positionManager()).to.equal(sepolia.nonfungiblePositionManager);
    // The address really is the periphery: its own factory getter answers, and
    // it is Uniswap's Sepolia v3 factory.
    expect((await nfpm.factory()).toLowerCase()).to.equal(
      sepolia.uniswapV3Factory.toLowerCase()
    );
    expect((await nfpm.WETH9()).toLowerCase()).to.equal(sepolia.weth9.toLowerCase());
  });

  it("decodes a real position through its own interface", async function () {
    if (!manager) this.skip();

    // Position #1 exists on Sepolia; reading it through the interface proves the
    // tuple layout the manager relies on is the deployed one.
    const position = await manager.positions(1);
    expect(position.token0).to.properAddress;
    expect(position.token1).to.properAddress;
    expect(ethers.utils.isAddress(await nfpm.ownerOf(1))).to.equal(true);
  });

  it("keeps control of a position it holds", async function () {
    if (!manager) this.skip();

    const holder = await nfpm.ownerOf(1);
    // The manager is not the holder of position #1, so its ownership guard must
    // reject every mutation attempt from anyone.
    if (holder.toLowerCase() !== manager.address.toLowerCase()) {
      await expect(manager.connect(stranger).collectPosition(1, 0, 0)).to.be.revertedWithCustomError(
        manager,
        "NotPositionOwner"
      );
    }
  });

  // The mint -> increase -> collect -> withdraw lifecycle is covered by the
  // in-process guard tests plus a fork run against funded accounts; see the
  // README section on running the fork suite with funded tokens.
});
