const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("ConnextAdapter", function () {
  // Define a fixture to reuse the same setup in multiple tests
  async function deployConnextAdapterFixture() {
    // Get signers
    const [owner, user, router] = await ethers.getSigners();
    
    // Deploy mock token
    const MockToken = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockToken.deploy("Mock Token", "MTK", 18);
    await mockToken.deployed();
    
    // Deploy mock Connext
    const MockConnext = await ethers.getContractFactory("MockConnext");
    const mockConnext = await MockConnext.deploy();
    await mockConnext.deployed();
    
    // Deploy ConnextAdapter
    const ConnextAdapter = await ethers.getContractFactory("ConnextAdapter");
    const connextAdapter = await ConnextAdapter.deploy(mockConnext.address);
    await connextAdapter.deployed();
    
    // Set up domain mappings
    const ethereumChainId = 1;
    const polygonChainId = 137;
    const ethereumDomain = 6648936;  // Example Connext domain for Ethereum
    const polygonDomain = 1886350457; // Example Connext domain for Polygon
    
    await connextAdapter.setDomainMapping(ethereumChainId, ethereumDomain);
    await connextAdapter.setDomainMapping(polygonChainId, polygonDomain);
    
    // Mint some tokens to the adapter for testing
    const mintAmount = ethers.utils.parseEther("1000");
    await mockToken.mint(connextAdapter.address, mintAmount);
    
    return { 
      connextAdapter, 
      mockConnext, 
      mockToken, 
      owner, 
      user, 
      router,
      ethereumChainId,
      polygonChainId,
      ethereumDomain,
      polygonDomain,
      mintAmount 
    };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { connextAdapter, owner } = await loadFixture(deployConnextAdapterFixture);
      expect(await connextAdapter.owner()).to.equal(owner.address);
    });

    it("Should set the Connext contract correctly", async function () {
      const { connextAdapter, mockConnext } = await loadFixture(deployConnextAdapterFixture);
      expect(await connextAdapter.connext()).to.equal(mockConnext.address);
    });
    
    it("Should map chain IDs to domains correctly", async function () {
      const { connextAdapter, ethereumChainId, polygonChainId, ethereumDomain, polygonDomain } = await loadFixture(deployConnextAdapterFixture);
      expect(await connextAdapter.chainToDomain(ethereumChainId)).to.equal(ethereumDomain);
      expect(await connextAdapter.chainToDomain(polygonChainId)).to.equal(polygonDomain);
    });
  });

  describe("Quote fees", function () {
    it("Should revert if destination domain is not mapped", async function () {
      const { connextAdapter, mockToken, user } = await loadFixture(deployConnextAdapterFixture);
      
      // Create a bridge request with unmapped destination chain
      const request = {
        id: 1,
        srcChainId: 1, // Ethereum
        dstChainId: 56, // BSC (unmapped)
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: ethers.utils.parseEther("0.01")
      };
      
      await expect(
        connextAdapter.quoteFees(request)
      ).to.be.revertedWith("ConnextAdapter: Invalid destination domain");
    });
    
    it("Should return the correct fee from Connext", async function () {
      const { connextAdapter, mockConnext, mockToken, user, ethereumChainId, polygonChainId, polygonDomain } = await loadFixture(deployConnextAdapterFixture);
      
      // Set expected fee in mock Connext
      const expectedFee = ethers.utils.parseEther("0.025");
      await mockConnext.setRelayerFee(expectedFee);
      
      // Create a bridge request
      const request = {
        id: 1,
        srcChainId: ethereumChainId,
        dstChainId: polygonChainId,
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Call quoteFees and verify
      const fee = await connextAdapter.quoteFees(request);
      expect(fee).to.equal(expectedFee);
      
      // Verify Connext was called with correct params
      expect(await mockConnext.lastDestinationDomain()).to.equal(polygonDomain);
      expect(await mockConnext.lastTokenAddress()).to.equal(mockToken.address);
      expect(await mockConnext.lastAmount()).to.equal(ethers.utils.parseEther("10"));
    });
  });

  describe("Bridge out", function () {
    it("Should revert if destination domain is not mapped", async function () {
      const { connextAdapter, mockToken, user, router } = await loadFixture(deployConnextAdapterFixture);
      
      // Create a bridge request with unmapped destination chain
      const request = {
        id: 1,
        srcChainId: 1, // Ethereum
        dstChainId: 56, // BSC (unmapped)
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Generate a request ID
      const requestId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'address', 'uint256', 'uint256'],
          [1, user.address, request.srcChainId, request.dstChainId]
        )
      );
      
      await expect(
        connextAdapter.connect(router).bridgeOut(request, requestId, { value: request.fee })
      ).to.be.revertedWith("ConnextAdapter: Invalid destination domain");
    });
    
    it("Should transfer tokens from router to adapter", async function () {
      const { connextAdapter, mockConnext, mockToken, user, router, ethereumChainId, polygonChainId } = await loadFixture(deployConnextAdapterFixture);
      
      const amount = ethers.utils.parseEther("10");
      const fee = ethers.utils.parseEther("0.01");
      
      // Set expected transfer ID in mock Connext
      const expectedTransferId = "0x" + "1".repeat(64);
      await mockConnext.setTransferId(expectedTransferId);
      
      // Mint tokens to the router and approve the adapter
      await mockToken.mint(router.address, amount);
      await mockToken.connect(router).approve(connextAdapter.address, amount);
      
      // Create a bridge request
      const request = {
        id: 1,
        srcChainId: ethereumChainId,
        dstChainId: polygonChainId,
        token: mockToken.address,
        amount: amount,
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: fee
      };
      
      // Generate a request ID
      const requestId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'address', 'uint256', 'uint256'],
          [1, user.address, request.srcChainId, request.dstChainId]
        )
      );
      
      // Initial token balances
      const routerBalanceBefore = await mockToken.balanceOf(router.address);
      const adapterBalanceBefore = await mockToken.balanceOf(connextAdapter.address);
      
      // Call bridgeOut
      await expect(
        connextAdapter.connect(router).bridgeOut(request, requestId, { value: fee })
      ).to.emit(connextAdapter, "ConnextTransferInitiated")
        .withArgs(requestId, expectedTransferId);
      
      // Check token balances after
      const routerBalanceAfter = await mockToken.balanceOf(router.address);
      const adapterBalanceAfter = await mockToken.balanceOf(connextAdapter.address);
      
      expect(routerBalanceBefore.sub(routerBalanceAfter)).to.equal(amount);
      expect(adapterBalanceAfter.sub(adapterBalanceBefore)).to.equal(amount);
      
      // Verify Connext xcTransfer was called with correct params
      expect(await mockConnext.lastDestinationDomain()).to.equal(await connextAdapter.chainToDomain(polygonChainId));
      expect(await mockConnext.lastRecipient()).to.equal(user.address);
      expect(await mockConnext.lastTokenAddress()).to.equal(mockToken.address);
      expect(await mockConnext.lastAmount()).to.equal(amount);
      expect(await mockConnext.lastSlippage()).to.equal(300); // 3% slippage
      expect(await mockConnext.lastRelayerFee()).to.equal(fee);
      
      // Verify request ID to transfer ID mapping
      expect(await connextAdapter.requestToTransferId(requestId)).to.equal(expectedTransferId);
    });
  });
  
  describe("Bridge in", function () {
    it("Should call completeTransfer on Connext with correct parameters", async function () {
      const { connextAdapter, mockConnext, mockToken, user, router, ethereumChainId, polygonChainId, ethereumDomain } = await loadFixture(deployConnextAdapterFixture);
      
      // Create a bridge request
      const request = {
        id: 1,
        srcChainId: ethereumChainId,
        dstChainId: polygonChainId,
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Generate a request ID
      const requestId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'address', 'uint256', 'uint256'],
          [1, user.address, request.srcChainId, request.dstChainId]
        )
      );
      
      // Set a transfer ID for this request
      const transferId = "0x" + "1".repeat(64);
      await connextAdapter.connect(owner).setRequestTransferId(requestId, transferId);
      
      // Create proof data
      const nonce = 12345;
      const originSender = "0x" + "2".repeat(64);
      const bridgeData = "0x1234";
      
      const proof = ethers.utils.defaultAbiCoder.encode(
        ['uint32', 'uint32', 'bytes32', 'bytes'],
        [ethereumDomain, nonce, originSender, bridgeData]
      );
      
      // Call bridgeIn
      await expect(
        connextAdapter.connect(router).bridgeIn(request, requestId, proof)
      ).to.emit(connextAdapter, "ConnextTransferCompleted")
        .withArgs(requestId, transferId);
      
      // Verify Connext completeTransfer was called with correct params
      expect(await mockConnext.lastOriginDomain()).to.equal(ethereumDomain);
      expect(await mockConnext.lastNonce()).to.equal(nonce);
      expect(await mockConnext.lastOriginSender()).to.equal(originSender);
      expect(await mockConnext.lastBridgeData()).to.equal(bridgeData);
    });
  });
  
  describe("Owner functions", function () {
    it("Should allow owner to set domain mapping", async function () {
      const { connextAdapter, owner } = await loadFixture(deployConnextAdapterFixture);
      
      const chainId = 56; // BSC
      const domain = 9876543210; // Example domain
      
      await connextAdapter.connect(owner).setDomainMapping(chainId, domain);
      expect(await connextAdapter.chainToDomain(chainId)).to.equal(domain);
    });
    
    it("Should revert if non-owner tries to set domain mapping", async function () {
      const { connextAdapter, user } = await loadFixture(deployConnextAdapterFixture);
      
      const chainId = 56; // BSC
      const domain = 9876543210; // Example domain
      
      await expect(
        connextAdapter.connect(user).setDomainMapping(chainId, domain)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
    
    it("Should allow owner to withdraw tokens", async function () {
      const { connextAdapter, mockToken, owner } = await loadFixture(deployConnextAdapterFixture);
      
      const amount = ethers.utils.parseEther("100");
      
      // Ensure the adapter has tokens
      const adapterBalance = await mockToken.balanceOf(connextAdapter.address);
      expect(adapterBalance).to.be.gte(amount);
      
      // Initial owner balance
      const ownerBalanceBefore = await mockToken.balanceOf(owner.address);
      
      // Withdraw tokens
      await connextAdapter.connect(owner).withdraw(mockToken.address, amount);
      
      // Check balances after
      const ownerBalanceAfter = await mockToken.balanceOf(owner.address);
      expect(ownerBalanceAfter.sub(ownerBalanceBefore)).to.equal(amount);
    });
  });
}); 