// Protocol fees against the REAL Uniswap v3 factory, pools and swaps, on a
// Sepolia fork.
//
// This is the regression test for the wiring gap: `HyperDexFactory` used to
// record a protocol fee in its own storage without ever telling the pool, so no
// fee was ever taken. Here the pool is a real `UniswapV3Pool` deployed by
// Uniswap's own Sepolia factory, the swap is a real swap with real token
// transfers, and the protocol's share is asserted from the pool's own state and
// balances.
//
// On a fork we take the real factory's ownership by impersonating its current
// owner; that is the only way to prove our contract can actually act as the
// factory owner, and it is confined to the ephemeral fork state.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { sepolia } = require("./helpers/addresses");
const { skipUnlessForked, impersonate, stopImpersonating, fundWithEther } = require("./helpers/fork");
const { getSqrtRatioAtTick, getMinTick, getMaxTick } = require("../helpers/v3");

const FEE = 3000;
const TICK_SPACING = 60;
const LIQUIDITY = 10n ** 18n;
const MAX_UINT128 = ethers.BigNumber.from(2).pow(128).sub(1);

const V3_FACTORY_ABI = [
  "function owner() view returns (address)",
  "function setOwner(address) external",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function protocolFees() view returns (uint128 token0, uint128 token1)",
  "function initialize(uint160) external",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const WETH_ABI = [
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

describe("Protocol fees on a Sepolia fork (real Uniswap v3)", function () {
  let admin, trader, recipient;
  let v3Factory, hyperDexFactory, pool, weth, token, callee;
  let token0, token1;

  before(async function () {
    if (!(await skipUnlessForked(sepolia.chainId, this))) return;

    [admin, trader, recipient] = await ethers.getSigners();

    v3Factory = new ethers.Contract(sepolia.uniswapV3Factory, V3_FACTORY_ABI, ethers.provider);

    const HyperDexFactory = await ethers.getContractFactory("HyperDexFactory");
    hyperDexFactory = await HyperDexFactory.deploy(sepolia.uniswapV3Factory);
    await hyperDexFactory.deployed();

    // Become the real factory's owner so real pools will accept our settings.
    const realOwner = await v3Factory.owner();
    await fundWithEther(realOwner, "10");
    const ownerSigner = await impersonate(realOwner);
    await v3Factory.connect(ownerSigner).setOwner(hyperDexFactory.address);
    await stopImpersonating(realOwner);
    expect(await v3Factory.owner()).to.equal(hyperDexFactory.address);

    // Real WETH, plus Uniswap's own v3-core test ERC20 (contracts/test) as the
    // pair. TestERC20 is a plain ERC20, not a protocol stand-in.
    weth = new ethers.Contract(sepolia.weth9, WETH_ABI, ethers.provider);
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    token = await TestERC20.deploy(2n ** 255n - 1n);
    await token.deployed();

    await hyperDexFactory.createPool(sepolia.weth9, token.address, FEE);
    const poolAddress = await hyperDexFactory.getPool(sepolia.weth9, token.address, FEE);
    expect(await ethers.provider.getCode(poolAddress)).to.not.equal("0x");

    pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
    await pool.initialize(getSqrtRatioAtTick(0));

    token0 = await pool.token0();
    token1 = await pool.token1();

    const Callee = await ethers.getContractFactory("TestUniswapV3Callee");
    callee = await Callee.deploy();
    await callee.deployed();

    // Fund the liquidity provider with both sides of the pair.
    await fundWithEther(admin.address, "10");
    await weth.connect(admin).deposit({ value: ethers.utils.parseEther("2") });
    await token.mint(admin.address, ethers.utils.parseEther("100"));

    const token0Contract = token0 === sepolia.weth9 ? weth.connect(admin) : token.connect(admin);
    const token1Contract = token1 === sepolia.weth9 ? weth.connect(admin) : token.connect(admin);
    await token0Contract.approve(callee.address, ethers.constants.MaxUint256);
    await token1Contract.approve(callee.address, ethers.constants.MaxUint256);

    await callee.mint(
      pool.address,
      admin.address,
      getMinTick(TICK_SPACING),
      getMaxTick(TICK_SPACING),
      LIQUIDITY
    );

    // Fund the trader with token0 (the token a zeroForOne swap spends).
    await fundWithEther(trader.address, "10");
    if (token0 === sepolia.weth9) {
      await weth.connect(trader).deposit({ value: ethers.utils.parseEther("2") });
    } else {
      await token.mint(trader.address, ethers.utils.parseEther("10"));
    }
    const traderToken0 = token0 === sepolia.weth9 ? weth.connect(trader) : token.connect(trader);
    await traderToken0.approve(callee.address, ethers.constants.MaxUint256);
    await weth.connect(trader).approve(callee.address, ethers.constants.MaxUint256);
  });

  it("creates a real pool through Uniswap's own factory", async function () {
    expect(await hyperDexFactory.getPool(sepolia.weth9, token.address, FEE)).to.equal(pool.address);
    expect(await hyperDexFactory.isPool(pool.address)).to.equal(true);

    const info = await hyperDexFactory.getPoolInfo(sepolia.weth9, token.address, FEE);
    expect(info.enabled).to.equal(true);
    expect(Number(info.tickSpacing)).to.equal(TICK_SPACING);
  });

  it("applies a protocol fee to the pool itself, not just to registry storage", async function () {
    expect((await pool.slot0()).feeProtocol).to.equal(0);

    await expect(hyperDexFactory.setProtocolFee(pool.address, 5)).to.emit(
      hyperDexFactory,
      "ProtocolFeeUpdated"
    );

    // v3 packs the two denominators into one byte: low nibble token0, high
    // nibble token1. 5/5 => 0x55, asserted from the pool's own state.
    expect((await pool.slot0()).feeProtocol).to.equal(0x55);
    expect(await hyperDexFactory.getProtocolFee(pool.address)).to.equal(5);
  });

  it("rejects invalid denominators and unknown pools", async function () {
    await expect(hyperDexFactory.setProtocolFee(pool.address, 3)).to.be.revertedWithCustomError(
      hyperDexFactory,
      "InvalidProtocolFee"
    );
    await expect(hyperDexFactory.setProtocolFee(recipient.address, 5)).to.be.revertedWithCustomError(
      hyperDexFactory,
      "UnknownPool"
    );
  });

  it("accrues protocol fees on a real swap and lets the owner collect them", async function () {
    const before = await pool.protocolFees();
    expect(before.token0.add(before.token1)).to.equal(0);

    const amountIn = ethers.utils.parseEther("0.5");
    const limit = getSqrtRatioAtTick(getMinTick(TICK_SPACING));
    await callee.connect(trader).swapExact0For1(pool.address, amountIn, trader.address, limit);

    const accrued = await pool.protocolFees();
    // A zeroForOne swap charges fees in token0 only.
    expect(accrued.token0, "no protocol fee accrued on a real swap").to.be.greaterThan(0);

    const recipientBefore = await (token0 === sepolia.weth9
      ? weth.balanceOf(recipient.address)
      : token.balanceOf(recipient.address));

    await hyperDexFactory.collectProtocolFees(
      pool.address,
      recipient.address,
      MAX_UINT128,
      MAX_UINT128
    );

    const recipientAfter = await (token0 === sepolia.weth9
      ? weth.balanceOf(recipient.address)
      : token.balanceOf(recipient.address));
    expect(recipientAfter.sub(recipientBefore), "recipient received nothing").to.equal(accrued.token0);

    const drained = await pool.protocolFees();
    expect(drained.token0.add(drained.token1)).to.equal(0);
  });

  it("drives the pool's protocol fee from the Chainlink-backed controller", async function () {
    const Controller = await ethers.getContractFactory("FeeController");
    const feeController = await Controller.deploy(sepolia.chainlinkEthUsd, 10, 4);
    await feeController.deployed();

    await feeController.update();
    const denominator = await feeController.getProtocolFeeDenominator();

    await hyperDexFactory.setFeeController(feeController.address);
    await expect(hyperDexFactory.applyProtocolFee(pool.address)).to.emit(
      hyperDexFactory,
      "ProtocolFeeUpdated"
    );

    const expected = denominator + (denominator << 4);
    expect((await pool.slot0()).feeProtocol).to.equal(expected);
  });

  it("refuses applyProtocolFee when no controller is installed", async function () {
    const HyperDexFactory = await ethers.getContractFactory("HyperDexFactory");
    const fresh = await HyperDexFactory.deploy(sepolia.uniswapV3Factory);
    await fresh.deployed();
    await expect(fresh.applyProtocolFee(pool.address)).to.be.revertedWithCustomError(
      fresh,
      "ZeroAddress"
    );
  });
});
