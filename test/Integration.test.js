const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Cross-Chain Integration", function () {
  // Define a fixture to reuse the same setup in multiple tests
  async function deployIntegrationFixture() {
    // Get signers
    const [owner, user, relayer] = await ethers.getSigners();
    
    // Chain IDs
    const ethereumChainId = 1; // Ethereum
    const polygonChainId = 137; // Polygon
    const arbitrumChainId = 42161; // Arbitrum
    
    // Deploy mock tokens
    const MockToken = await ethers.getContractFactory("MockERC20");
    const mockTokenEthereum = await MockToken.deploy("Ethereum Token", "ETH", 18);
    await mockTokenEthereum.deployed();
    
    const mockTokenPolygon = await MockToken.deploy("Polygon Token", "MATIC", 18);
    await mockTokenPolygon.deployed();
    
    const mockTokenArbitrum = await MockToken.deploy("Arbitrum Token", "ARB", 18);
    await mockTokenArbitrum.deployed();
    
    // Mint tokens to user for testing
    await mockTokenEthereum.mint(user.address, ethers.utils.parseEther("1000"));
    await mockTokenPolygon.mint(user.address, ethers.utils.parseEther("1000"));
    await mockTokenArbitrum.mint(user.address, ethers.utils.parseEther("1000"));
    
    // Deploy mock adapters
    // 1. Connext Adapter Setup
    const MockConnext = await ethers.getContractFactory("MockConnext");
    const mockConnext = await MockConnext.deploy();
    await mockConnext.deployed();
    
    // 2. LayerZero Adapter Setup
    const MockLayerZeroEndpoint = await ethers.getContractFactory("MockLayerZeroEndpoint");
    const mockLzEndpoint = await MockLayerZeroEndpoint.deploy();
    await mockLzEndpoint.deployed();
    
    // Deploy BridgeRouter
    const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
    const bridgeRouter = await BridgeRouter.deploy();
    await bridgeRouter.deployed();
    
    // Deploy Adapters
    const ConnextAdapter = await ethers.getContractFactory("ConnextAdapter");
    const connextAdapter = await ConnextAdapter.deploy(mockConnext.address, bridgeRouter.address);
    await connextAdapter.deployed();
    
    const LayerZeroAdapter = await ethers.getContractFactory("LayerZeroAdapter");
    const layerZeroAdapter = await LayerZeroAdapter.deploy(mockLzEndpoint.address, bridgeRouter.address);
    await layerZeroAdapter.deployed();
    
    // Configure BridgeRouter
    await bridgeRouter.initialize(owner.address, relayer.address, ethereumChainId);
    
    // Setup domain mappings for Connext
    await connextAdapter.setDomainMapping(ethereumChainId, 6648936);  // Example Connext domain ID for Ethereum
    await connextAdapter.setDomainMapping(polygonChainId, 1886350457);  // Example Connext domain ID for Polygon
    
    // Setup chain mappings for LayerZero
    await layerZeroAdapter.setChainMapping(ethereumChainId, 101);  // Example LZ ID for Ethereum
    await layerZeroAdapter.setChainMapping(arbitrumChainId, 110);  // Example LZ ID for Arbitrum
    
    // Setup trusted remotes for LayerZero
    const trustedRemoteEthereum = ethers.utils.defaultAbiCoder.encode(
      ['address'],
      [layerZeroAdapter.address]
    );
    
    const trustedRemoteArbitrum = ethers.utils.defaultAbiCoder.encode(
      ['address'],
      [layerZeroAdapter.address]
    );
    
    await layerZeroAdapter.setTrustedRemote(101, trustedRemoteEthereum);
    await layerZeroAdapter.setTrustedRemote(110, trustedRemoteArbitrum);
    
    // Register adapters with BridgeRouter
    await bridgeRouter.registerAdapter(connextAdapter.address);
    await bridgeRouter.registerAdapter(layerZeroAdapter.address);
    
    // Configure adapter chains
    await bridgeRouter.setAdapterForChain(polygonChainId, connextAdapter.address);
    await bridgeRouter.setAdapterForChain(arbitrumChainId, layerZeroAdapter.address);
    
    // Configure token mappings (assuming same address for simplicity, in reality these would be different on each chain)
    await bridgeRouter.addSupportedToken(mockTokenEthereum.address);
    await bridgeRouter.addTokenMapping(mockTokenEthereum.address, polygonChainId, mockTokenPolygon.address);
    await bridgeRouter.addTokenMapping(mockTokenEthereum.address, arbitrumChainId, mockTokenArbitrum.address);
    
    // Approve router to spend user tokens
    await mockTokenEthereum.connect(user).approve(bridgeRouter.address, ethers.utils.parseEther("1000"));
    
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
      ethereumChainId,
      polygonChainId,
      arbitrumChainId
    };
  }

  describe("BridgeRouter with multiple adapters", function () {
    it("Should set up contracts correctly", async function () {
      const { 
        bridgeRouter, 
        connextAdapter, 
        layerZeroAdapter, 
        mockConnext, 
        mockLzEndpoint,
        ethereumChainId,
        polygonChainId,
        arbitrumChainId
      } = await loadFixture(deployIntegrationFixture);
      
      // Check BridgeRouter configuration
      expect(await bridgeRouter.currentChainId()).to.equal(ethereumChainId);
      
      // Check adapter registrations
      expect(await bridgeRouter.isAdapterRegistered(connextAdapter.address)).to.be.true;
      expect(await bridgeRouter.isAdapterRegistered(layerZeroAdapter.address)).to.be.true;
      
      // Check chain to adapter mappings
      expect(await bridgeRouter.getAdapterForChain(polygonChainId)).to.equal(connextAdapter.address);
      expect(await bridgeRouter.getAdapterForChain(arbitrumChainId)).to.equal(layerZeroAdapter.address);
      
      // Check ConnextAdapter configuration
      expect(await connextAdapter.connext()).to.equal(mockConnext.address);
      expect(await connextAdapter.bridgeRouter()).to.equal(bridgeRouter.address);
      
      // Check LayerZeroAdapter configuration
      expect(await layerZeroAdapter.endpoint()).to.equal(mockLzEndpoint.address);
      expect(await layerZeroAdapter.bridgeRouter()).to.equal(bridgeRouter.address);
    });
    
    it("Should quote fees correctly for different chains", async function () {
      const { 
        bridgeRouter, 
        mockConnext,
        mockLzEndpoint, 
        mockTokenEthereum, 
        user,
        ethereumChainId,
        polygonChainId,
        arbitrumChainId
      } = await loadFixture(deployIntegrationFixture);
      
      // Set up expected fees in the mock adapters
      const connextFee = ethers.utils.parseEther("0.01");
      const layerZeroFee = ethers.utils.parseEther("0.02");
      
      await mockConnext.setRelayerFee(connextFee);
      await mockLzEndpoint.setNativeFee(layerZeroFee);
      
      // Quote fee for Polygon (Connext)
      const polygonFee = await bridgeRouter.quoteBridgeFee(
        mockTokenEthereum.address,
        ethers.utils.parseEther("10"),
        polygonChainId
      );
      expect(polygonFee).to.equal(connextFee);
      
      // Quote fee for Arbitrum (LayerZero)
      const arbitrumFee = await bridgeRouter.quoteBridgeFee(
        mockTokenEthereum.address,
        ethers.utils.parseEther("10"),
        arbitrumChainId
      );
      expect(arbitrumFee).to.equal(layerZeroFee);
    });
    
    it("Should initiate bridge to Polygon via Connext", async function () {
      const { 
        bridgeRouter, 
        connextAdapter,
        mockConnext, 
        mockTokenEthereum, 
        user,
        ethereumChainId,
        polygonChainId
      } = await loadFixture(deployIntegrationFixture);
      
      const amount = ethers.utils.parseEther("10");
      const fee = ethers.utils.parseEther("0.01");
      await mockConnext.setRelayerFee(fee);
      
      // Get user balance before
      const userBalanceBefore = await mockTokenEthereum.balanceOf(user.address);
      
      // Generate deadline
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      
      // Initiate bridge
      const tx = await bridgeRouter.connect(user).bridge(
        mockTokenEthereum.address,
        amount,
        polygonChainId,
        user.address,
        deadline,
        { value: fee }
      );
      
      // Verify event and token transfer
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "BridgeInitiated");
      expect(event).to.not.be.undefined;
      
      // Verify requestId is properly generated
      const requestId = event.args.requestId;
      
      // Check user balance after
      const userBalanceAfter = await mockTokenEthereum.balanceOf(user.address);
      expect(userBalanceBefore.sub(userBalanceAfter)).to.equal(amount);
      
      // Check that Connext adapter received the right transfer ID
      const transferId = await mockConnext.lastTransferId();
      expect(await connextAdapter.requestToTransferId(requestId)).to.equal(transferId);
    });
    
    it("Should initiate bridge to Arbitrum via LayerZero", async function () {
      const { 
        bridgeRouter, 
        layerZeroAdapter,
        mockLzEndpoint, 
        mockTokenEthereum, 
        user,
        ethereumChainId,
        arbitrumChainId
      } = await loadFixture(deployIntegrationFixture);
      
      const amount = ethers.utils.parseEther("10");
      const fee = ethers.utils.parseEther("0.02");
      await mockLzEndpoint.setNativeFee(fee);
      
      // Get user balance before
      const userBalanceBefore = await mockTokenEthereum.balanceOf(user.address);
      
      // Generate deadline
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      
      // Initiate bridge
      const tx = await bridgeRouter.connect(user).bridge(
        mockTokenEthereum.address,
        amount,
        arbitrumChainId,
        user.address,
        deadline,
        { value: fee }
      );
      
      // Verify event and token transfer
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "BridgeInitiated");
      expect(event).to.not.be.undefined;
      
      // Verify requestId is properly generated
      const requestId = event.args.requestId;
      
      // Check user balance after
      const userBalanceAfter = await mockTokenEthereum.balanceOf(user.address);
      expect(userBalanceBefore.sub(userBalanceAfter)).to.equal(amount);
      
      // Check that a message was sent via LayerZero endpoint
      expect(await mockLzEndpoint.lastDstChainId()).to.equal(110); // LZ ID for Arbitrum
      
      // Check that the payload was stored
      expect(await layerZeroAdapter.requestPayloads(requestId)).to.not.equal('0x');
    });
    
    it("Should complete bridge from Polygon via relayer", async function () {
      const { 
        bridgeRouter, 
        connextAdapter,
        mockConnext,
        mockTokenPolygon,
        owner,
        user,
        relayer,
        ethereumChainId,
        polygonChainId
      } = await loadFixture(deployIntegrationFixture);
      
      const amount = ethers.utils.parseEther("10");
      
      // Create bridge request
      const request = {
        id: 1,
        srcChainId: polygonChainId,
        dstChainId: ethereumChainId,
        token: mockTokenPolygon.address,
        amount: amount,
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Generate requestId
      const requestId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'address', 'uint256', 'uint256'],
          [request.id, request.user, request.srcChainId, request.dstChainId]
        )
      );
      
      // Generate a mock transferId and map it to the request
      const transferId = ethers.utils.hexZeroPad("0x1", 32);
      await connextAdapter.setRequestTransferId(requestId, transferId);
      
      // Mint tokens to BridgeRouter (simulating the token arrive on destination)
      await mockTokenPolygon.mint(bridgeRouter.address, amount);
      
      // Relayer signs the message
      const domain = {
        name: "HyperDex Bridge",
        version: "1",
        chainId: ethereumChainId,
        verifyingContract: bridgeRouter.address
      };
      
      const types = {
        BridgeRequest: [
          { name: "id", type: "uint256" },
          { name: "srcChainId", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "user", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "fee", type: "uint256" }
        ]
      };
      
      const signature = await relayer._signTypedData(domain, types, request);
      
      // User balance before
      const userBalanceBefore = await mockTokenPolygon.balanceOf(user.address);
      
      // Complete the bridge
      await bridgeRouter.connect(user).completeBridge(request, signature);
      
      // Check user received tokens
      const userBalanceAfter = await mockTokenPolygon.balanceOf(user.address);
      expect(userBalanceAfter.sub(userBalanceBefore)).to.equal(amount);
    });
    
    it("Should complete bridge from Arbitrum via LayerZero message", async function () {
      const { 
        bridgeRouter,
        layerZeroAdapter,
        mockLzEndpoint,
        mockTokenArbitrum,
        owner,
        user,
        ethereumChainId,
        arbitrumChainId
      } = await loadFixture(deployIntegrationFixture);
      
      const amount = ethers.utils.parseEther("10");
      
      // Create bridge request
      const request = {
        id: 1,
        srcChainId: arbitrumChainId,
        dstChainId: ethereumChainId,
        token: mockTokenArbitrum.address,
        amount: amount,
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: ethers.utils.parseEther("0.02")
      };
      
      // Generate requestId
      const requestId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'address', 'uint256', 'uint256'],
          [request.id, request.user, request.srcChainId, request.dstChainId]
        )
      );
      
      // Mint tokens to BridgeRouter (simulating the token arrive on destination)
      await mockTokenArbitrum.mint(bridgeRouter.address, amount);
      
      // Encode the payload that would be sent by the source chain
      const payload = ethers.utils.defaultAbiCoder.encode(
        ['tuple(uint256,uint256,uint256,address,uint256,address,uint256,uint256)', 'bytes32'],
        [
          [
            request.id,
            request.srcChainId,
            request.dstChainId,
            request.token,
            request.amount,
            request.user,
            request.deadline,
            request.fee
          ],
          requestId
        ]
      );
      
      // User balance before
      const userBalanceBefore = await mockTokenArbitrum.balanceOf(user.address);
      
      // Get the trusted remote for LayerZero
      const trustedRemote = await layerZeroAdapter.trustedRemoteLookup(110); // LZ ID for Arbitrum
      
      // Simulate receiving a message from LayerZero
      await mockLzEndpoint.receiveMessage(
        110, // LZ ID for Arbitrum
        trustedRemote,
        layerZeroAdapter.address,
        1, // nonce
        payload
      );
      
      // Check user received tokens
      const userBalanceAfter = await mockTokenArbitrum.balanceOf(user.address);
      expect(userBalanceAfter.sub(userBalanceBefore)).to.equal(amount);
    });
  });
}); 