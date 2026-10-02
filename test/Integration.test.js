const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { signBridgeRequest } = require("./helpers/bridge-eip712");

/**
 * Exercises the BridgeRouter with two different protocols registered at once:
 * Connext for Polygon and LayerZero for Arbitrum. Adapters are keyed by the
 * chain they know how to reach, so both routes coexist on one router.
 */
describe("Cross-Chain Integration", function () {
  const ETHEREUM_CHAIN_ID = 1;
  const POLYGON_CHAIN_ID = 137;
  const ARBITRUM_CHAIN_ID = 42161;

  const POLYGON_CONNEXT_DOMAIN = 1886350457;
  const ARBITRUM_LZ_ID = 110;
  const ETHEREUM_LZ_ID = 101;

  async function deployIntegrationFixture() {
    const [owner, user, relayer] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    const mockTokenEthereum = await MockToken.deploy("Ethereum Token", "ETH", 18);
    const mockTokenPolygon = await MockToken.deploy("Polygon Token", "MATIC", 18);
    const mockTokenArbitrum = await MockToken.deploy("Arbitrum Token", "ARB", 18);
    await Promise.all([mockTokenEthereum, mockTokenPolygon, mockTokenArbitrum].map((t) => t.deployed()));

    const mintAmount = ethers.utils.parseEther("1000");
    for (const token of [mockTokenEthereum, mockTokenPolygon, mockTokenArbitrum]) {
      await token.mint(user.address, mintAmount);
    }

    // Mock protocol endpoints
    const mockConnext = await (await ethers.getContractFactory("MockConnext")).deploy();
    const mockLzEndpoint = await (await ethers.getContractFactory("MockLayerZeroEndpoint")).deploy();
    await mockConnext.deployed();
    await mockLzEndpoint.deployed();

    const bridgeRouter = await (await ethers.getContractFactory("BridgeRouter")).deploy();
    await bridgeRouter.deployed();

    const connextAdapter = await (
      await ethers.getContractFactory("ConnextAdapter")
    ).deploy(mockConnext.address);
    const layerZeroAdapter = await (
      await ethers.getContractFactory("LayerZeroAdapter")
    ).deploy(mockLzEndpoint.address, bridgeRouter.address);
    await connextAdapter.deployed();
    await layerZeroAdapter.deployed();

    // Connext: chain id -> Connext domain
    await connextAdapter.setDomainMapping(POLYGON_CHAIN_ID, POLYGON_CONNEXT_DOMAIN);

    // LayerZero: chain id -> LayerZero endpoint id, plus the trusted remote
    await layerZeroAdapter.setChainMapping(ARBITRUM_CHAIN_ID, ARBITRUM_LZ_ID);
    await layerZeroAdapter.setChainMapping(ETHEREUM_CHAIN_ID, ETHEREUM_LZ_ID);
    const trustedRemote = ethers.utils.defaultAbiCoder.encode(["address"], [layerZeroAdapter.address]);
    await layerZeroAdapter.setTrustedRemote(ARBITRUM_LZ_ID, trustedRemote);
    await layerZeroAdapter.setTrustedRemote(ETHEREUM_LZ_ID, trustedRemote);

    // Route each destination through its own protocol.
    await bridgeRouter.registerAdapter(POLYGON_CHAIN_ID, connextAdapter.address);
    await bridgeRouter.registerAdapter(ARBITRUM_CHAIN_ID, layerZeroAdapter.address);
    await bridgeRouter.setRelayer(relayer.address, true);

    await mockTokenEthereum.connect(user).approve(bridgeRouter.address, mintAmount);

    return {
      bridgeRouter,
      connextAdapter,
      layerZeroAdapter,
      mockConnext,
      mockLzEndpoint,
      mockTokenEthereum,
      mockTokenPolygon,
      mockTokenArbitrum,
      owner,
      user,
      relayer,
      mintAmount,
      trustedRemote
    };
  }

  function makeRequest(token, amount, user, srcChainId, dstChainId, fee) {
    return {
      id: 1,
      srcChainId,
      dstChainId,
      token,
      amount,
      user,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      fee
    };
  }

  /** Initiates a bridge and returns the emitted requestId. */
  async function initiate(bridgeRouter, signer, relayer, request, value) {
    const signature = await signBridgeRequest(bridgeRouter, signer, request);
    const tx = await bridgeRouter.connect(relayer).initiateBridge(request, signature, { value });
    const receipt = await tx.wait();
    const event = receipt.events.find((e) => e.event === "BridgeInitiated");
    expect(event, "BridgeInitiated event").to.not.be.undefined;
    return event.args.requestId;
  }

  describe("BridgeRouter with multiple adapters", function () {
    it("Should set up contracts correctly", async function () {
      const { bridgeRouter, connextAdapter, layerZeroAdapter, mockConnext, mockLzEndpoint } =
        await loadFixture(deployIntegrationFixture);

      // Each destination resolves to its own adapter.
      expect(await bridgeRouter.bridgeAdapters(POLYGON_CHAIN_ID)).to.equal(connextAdapter.address);
      expect(await bridgeRouter.bridgeAdapters(ARBITRUM_CHAIN_ID)).to.equal(layerZeroAdapter.address);
      expect(await bridgeRouter.bridgeAdapters(POLYGON_CHAIN_ID)).to.not.equal(
        await bridgeRouter.bridgeAdapters(ARBITRUM_CHAIN_ID)
      );

      expect(await connextAdapter.connext()).to.equal(mockConnext.address);
      expect(await layerZeroAdapter.endpoint()).to.equal(mockLzEndpoint.address);
      expect(await layerZeroAdapter.bridgeRouter()).to.equal(bridgeRouter.address);
    });

    it("Should quote fees correctly for different chains", async function () {
      const { connextAdapter, layerZeroAdapter, mockConnext, mockLzEndpoint, mockTokenEthereum, user } =
        await loadFixture(deployIntegrationFixture);

      const connextFee = ethers.utils.parseEther("0.01");
      const layerZeroFee = ethers.utils.parseEther("0.02");
      await mockConnext.setRelayerFee(connextFee);
      await mockLzEndpoint.setNativeFee(layerZeroFee);

      const amount = ethers.utils.parseEther("10");

      const polygonFee = await connextAdapter.quoteFees(
        makeRequest(mockTokenEthereum.address, amount, user.address, ETHEREUM_CHAIN_ID, POLYGON_CHAIN_ID, 0)
      );
      expect(polygonFee).to.equal(connextFee);

      const arbitrumFee = await layerZeroAdapter.quoteFees(
        makeRequest(mockTokenEthereum.address, amount, user.address, ETHEREUM_CHAIN_ID, ARBITRUM_CHAIN_ID, 0)
      );
      expect(arbitrumFee).to.equal(layerZeroFee);
    });

    it("Should initiate bridge to Polygon via Connext", async function () {
      const { bridgeRouter, connextAdapter, mockConnext, mockTokenEthereum, user, relayer, mintAmount } =
        await loadFixture(deployIntegrationFixture);

      const amount = ethers.utils.parseEther("10");
      const fee = ethers.utils.parseEther("0.01");
      await mockConnext.setRelayerFee(fee);

      const balanceBefore = await mockTokenEthereum.balanceOf(user.address);
      const request = makeRequest(
        mockTokenEthereum.address,
        amount,
        user.address,
        ETHEREUM_CHAIN_ID,
        POLYGON_CHAIN_ID,
        fee
      );

      const requestId = await initiate(bridgeRouter, user, relayer, request, fee);

      // Escrowed exactly once, out of the user's balance, and handed to Connext.
      expect(balanceBefore.sub(await mockTokenEthereum.balanceOf(user.address))).to.equal(amount);
      expect(await mockTokenEthereum.balanceOf(mockConnext.address)).to.equal(amount);
      expect(await mockTokenEthereum.balanceOf(bridgeRouter.address)).to.equal(0);

      // Connext recorded the transfer and the adapter stored its id.
      expect(await connextAdapter.requestToTransferId(requestId)).to.equal(await mockConnext.transferId());
      expect(await mockConnext.lastDestinationDomain()).to.equal(POLYGON_CONNEXT_DOMAIN);
      expect(await mockConnext.lastRecipient()).to.equal(user.address);
      expect(await mockConnext.lastAmount()).to.equal(amount);
      expect(await mockTokenEthereum.balanceOf(user.address)).to.equal(mintAmount.sub(amount));
    });

    it("Should initiate bridge to Arbitrum via LayerZero", async function () {
      const { bridgeRouter, layerZeroAdapter, mockLzEndpoint, mockTokenEthereum, user, relayer } =
        await loadFixture(deployIntegrationFixture);

      const amount = ethers.utils.parseEther("10");
      const fee = ethers.utils.parseEther("0.02");
      await mockLzEndpoint.setNativeFee(fee);

      const request = makeRequest(
        mockTokenEthereum.address,
        amount,
        user.address,
        ETHEREUM_CHAIN_ID,
        ARBITRUM_CHAIN_ID,
        fee
      );

      const requestId = await initiate(bridgeRouter, user, relayer, request, fee);

      // The message went out through the LayerZero endpoint to the right chain.
      expect(await mockLzEndpoint.lastDstChainId()).to.equal(ARBITRUM_LZ_ID);
      expect(await layerZeroAdapter.requestPayloads(requestId)).to.not.equal("0x");
    });

    it("Should complete bridge from Polygon via relayer", async function () {
      const { bridgeRouter, connextAdapter, mockConnext, mockTokenPolygon, user, relayer } =
        await loadFixture(deployIntegrationFixture);

      const amount = ethers.utils.parseEther("10");
      const fee = ethers.utils.parseEther("0.01");
      await mockConnext.setRelayerFee(fee);

      const request = makeRequest(
        mockTokenPolygon.address,
        amount,
        user.address,
        ETHEREUM_CHAIN_ID,
        POLYGON_CHAIN_ID,
        fee
      );
      await mockTokenPolygon.connect(user).approve(bridgeRouter.address, amount);

      const requestId = await initiate(bridgeRouter, user, relayer, request, fee);

      // Connext already holds the escrowed amount from the outbound leg; the
      // inbound leg releases it to the user.
      const balanceBefore = await mockTokenPolygon.balanceOf(user.address);

      const proof = ethers.utils.defaultAbiCoder.encode(
        ["uint32", "uint32", "bytes32", "bytes"],
        [POLYGON_CONNEXT_DOMAIN, 1, ethers.utils.hexZeroPad("0x2", 32), "0x1234"]
      );

      await expect(bridgeRouter.connect(relayer).completeBridge(request, requestId, proof))
        .to.emit(bridgeRouter, "BridgeCompleted")
        .withArgs(requestId, request.user, request.token, request.amount);

      expect(await mockTokenPolygon.balanceOf(user.address)).to.equal(balanceBefore.add(amount));
      const [, status] = await bridgeRouter.getBridgeRequest(requestId);
      expect(status).to.equal(2); // RequestStatus.Completed
    });

    it("Should complete bridge from Arbitrum via LayerZero message", async function () {
      const { bridgeRouter, layerZeroAdapter, mockLzEndpoint, mockTokenArbitrum, user, relayer, trustedRemote } =
        await loadFixture(deployIntegrationFixture);

      const amount = ethers.utils.parseEther("10");
      const fee = ethers.utils.parseEther("0.02");
      await mockLzEndpoint.setNativeFee(fee);

      const request = makeRequest(
        mockTokenArbitrum.address,
        amount,
        user.address,
        ETHEREUM_CHAIN_ID,
        ARBITRUM_CHAIN_ID,
        fee
      );
      await mockTokenArbitrum.connect(user).approve(bridgeRouter.address, amount);

      const requestId = await initiate(bridgeRouter, user, relayer, request, fee);

      // Nothing can be released before the LayerZero message arrives.
      await mockTokenArbitrum.mint(layerZeroAdapter.address, amount);
      await expect(
        bridgeRouter.connect(relayer).completeBridge(request, requestId, "0x")
      ).to.be.revertedWith("LayerZeroAdapter: Message not verified");

      // Deliver the cross-chain message through the endpoint.
      const payload = ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(uint256 id,uint256 srcChainId,uint256 dstChainId,address token,uint256 amount,address user,uint256 deadline,uint256 fee)",
          "bytes32"
        ],
        [request, requestId]
      );
      await mockLzEndpoint.receiveMessage(
        ARBITRUM_LZ_ID,
        trustedRemote,
        layerZeroAdapter.address,
        1,
        payload
      );

      expect(await layerZeroAdapter.verifiedMessages(requestId)).to.equal(true);

      const balanceBefore = await mockTokenArbitrum.balanceOf(user.address);
      await bridgeRouter.connect(relayer).completeBridge(request, requestId, "0x");

      expect(await mockTokenArbitrum.balanceOf(user.address)).to.equal(balanceBefore.add(amount));
      expect(await layerZeroAdapter.completedMessages(requestId)).to.equal(true);

      // A second completion must not pay out again.
      await expect(
        bridgeRouter.connect(relayer).completeBridge(request, requestId, "0x")
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidStatus");
      expect(await mockTokenArbitrum.balanceOf(user.address)).to.equal(balanceBefore.add(amount));
    });

    it("Should refuse to route to a chain with no adapter", async function () {
      const { bridgeRouter, mockTokenEthereum, user, relayer } = await loadFixture(deployIntegrationFixture);

      const request = makeRequest(
        mockTokenEthereum.address,
        ethers.utils.parseEther("10"),
        user.address,
        ETHEREUM_CHAIN_ID,
        10, // Optimism: no adapter registered
        ethers.utils.parseEther("0.01")
      );
      const signature = await signBridgeRequest(bridgeRouter, user, request);

      await expect(
        bridgeRouter.connect(relayer).initiateBridge(request, signature, { value: request.fee })
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidAdapter");
    });
  });
});
