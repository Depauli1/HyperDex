const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("LayerZeroAdapter", function () {
  // Define a fixture to reuse the same setup in multiple tests
  async function deployLayerZeroAdapterFixture() {
    // Get signers
    const [owner, user, router] = await ethers.getSigners();
    
    // Deploy mock token
    const MockToken = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockToken.deploy("Mock Token", "MTK", 18);
    await mockToken.deployed();
    
    // Deploy mock LayerZero endpoint
    const MockLayerZeroEndpoint = await ethers.getContractFactory("MockLayerZeroEndpoint");
    const mockEndpoint = await MockLayerZeroEndpoint.deploy();
    await mockEndpoint.deployed();
    
    // Deploy LayerZeroAdapter
    const LayerZeroAdapter = await ethers.getContractFactory("LayerZeroAdapter");
    const layerZeroAdapter = await LayerZeroAdapter.deploy(mockEndpoint.address, router.address);
    await layerZeroAdapter.deployed();
    
    // Set up chain mappings
    const ethereumChainId = 1; // Ethereum
    const polygonChainId = 137; // Polygon
    const ethereumLzId = 101; // Example LayerZero ID for Ethereum
    const polygonLzId = 109; // Example LayerZero ID for Polygon
    
    await layerZeroAdapter.setChainMapping(ethereumChainId, ethereumLzId);
    await layerZeroAdapter.setChainMapping(polygonChainId, polygonLzId);
    
    // Set trusted remote on both chains
    const trustedRemoteEthereum = ethers.utils.defaultAbiCoder.encode(
      ['address'],
      [layerZeroAdapter.address]
    );
    
    const trustedRemotePolygon = ethers.utils.defaultAbiCoder.encode(
      ['address'],
      [layerZeroAdapter.address]
    );
    
    await layerZeroAdapter.setTrustedRemote(ethereumLzId, trustedRemoteEthereum);
    await layerZeroAdapter.setTrustedRemote(polygonLzId, trustedRemotePolygon);
    
    return { 
      layerZeroAdapter, 
      mockEndpoint, 
      mockToken, 
      owner, 
      user, 
      router,
      ethereumChainId,
      polygonChainId,
      ethereumLzId,
      polygonLzId
    };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { layerZeroAdapter, owner } = await loadFixture(deployLayerZeroAdapterFixture);
      expect(await layerZeroAdapter.owner()).to.equal(owner.address);
    });

    it("Should set the endpoint and bridge router correctly", async function () {
      const { layerZeroAdapter, mockEndpoint, router } = await loadFixture(deployLayerZeroAdapterFixture);
      expect(await layerZeroAdapter.endpoint()).to.equal(mockEndpoint.address);
      expect(await layerZeroAdapter.bridgeRouter()).to.equal(router.address);
    });
    
    it("Should map chain IDs to LayerZero IDs correctly", async function () {
      const { layerZeroAdapter, ethereumChainId, polygonChainId, ethereumLzId, polygonLzId } = await loadFixture(deployLayerZeroAdapterFixture);
      expect(await layerZeroAdapter.chainToLzId(ethereumChainId)).to.equal(ethereumLzId);
      expect(await layerZeroAdapter.chainToLzId(polygonChainId)).to.equal(polygonLzId);
    });
    
    it("Should set trusted remotes correctly", async function () {
      const { layerZeroAdapter, ethereumLzId, polygonLzId } = await loadFixture(deployLayerZeroAdapterFixture);
      
      const trustedRemoteEthereum = await layerZeroAdapter.trustedRemoteLookup(ethereumLzId);
      const trustedRemotePolygon = await layerZeroAdapter.trustedRemoteLookup(polygonLzId);
      
      expect(trustedRemoteEthereum).to.not.equal('0x');
      expect(trustedRemotePolygon).to.not.equal('0x');
    });
  });

  describe("Quote fees", function () {
    it("Should revert if destination chain is not mapped", async function () {
      const { layerZeroAdapter, mockToken, user } = await loadFixture(deployLayerZeroAdapterFixture);
      
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
        layerZeroAdapter.quoteFees(request)
      ).to.be.revertedWith("LayerZeroAdapter: Invalid destination chain");
    });
    
    it("Should revert if trusted remote is not configured", async function () {
      const { layerZeroAdapter, mockToken, user, owner } = await loadFixture(deployLayerZeroAdapterFixture);
      
      // Set a chain mapping without trusted remote
      const arbitrumChainId = 42161;
      const arbitrumLzId = 110;
      await layerZeroAdapter.connect(owner).setChainMapping(arbitrumChainId, arbitrumLzId);
      
      // Create a bridge request with the new chain
      const request = {
        id: 1,
        srcChainId: 1, // Ethereum
        dstChainId: arbitrumChainId, // Arbitrum (no trusted remote)
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: ethers.utils.parseEther("0.01")
      };
      
      await expect(
        layerZeroAdapter.quoteFees(request)
      ).to.be.revertedWith("LayerZeroAdapter: Remote not configured");
    });
    
    it("Should return the correct fee from LayerZero endpoint", async function () {
      const { layerZeroAdapter, mockEndpoint, mockToken, user, ethereumChainId, polygonChainId } = await loadFixture(deployLayerZeroAdapterFixture);
      
      // Set expected fee in mock endpoint
      const expectedFee = ethers.utils.parseEther("0.025");
      await mockEndpoint.setNativeFee(expectedFee);
      
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
      const fee = await layerZeroAdapter.quoteFees(request);
      expect(fee).to.equal(expectedFee);
    });
  });

  describe("Bridge out", function () {
    it("Should revert if caller is not the bridge router", async function () {
      const { layerZeroAdapter, mockToken, user, ethereumChainId, polygonChainId } = await loadFixture(deployLayerZeroAdapterFixture);
      
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
      
      // Call bridgeOut from user (not router)
      await expect(
        layerZeroAdapter.connect(user).bridgeOut(request, requestId, { value: request.fee })
      ).to.be.revertedWith("LayerZeroAdapter: Only bridge router");
    });
    
    it("Should send message via LayerZero endpoint", async function () {
      const { layerZeroAdapter, mockEndpoint, mockToken, user, router, ethereumChainId, polygonChainId, polygonLzId } = await loadFixture(deployLayerZeroAdapterFixture);
      
      const fee = ethers.utils.parseEther("0.01");
      
      // Create a bridge request
      const request = {
        id: 1,
        srcChainId: ethereumChainId,
        dstChainId: polygonChainId,
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
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
      
      // Call bridgeOut from router
      await expect(
        layerZeroAdapter.connect(router).bridgeOut(request, requestId, { value: fee })
      ).to.emit(layerZeroAdapter, "LayerZeroMessageSent")
        .withArgs(requestId, polygonLzId);
      
      // Verify the message was sent with correct parameters
      expect(await mockEndpoint.lastDstChainId()).to.equal(polygonLzId);
      expect(await layerZeroAdapter.requestPayloads(requestId)).to.not.equal('0x');
    });
  });
  
  describe("Bridge in", function () {
    it("Should allow bridgeIn to be called by anyone", async function () {
      const { layerZeroAdapter, mockToken, user, ethereumChainId, polygonChainId } = await loadFixture(deployLayerZeroAdapterFixture);
      
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
      
      // bridgeIn is a no-op in the LayerZero adapter so it should succeed
      await layerZeroAdapter.connect(user).bridgeIn(request, requestId, "0x");
    });
  });
  
  describe("lzReceive", function () {
    it("Should revert if caller is not the endpoint", async function () {
      const { layerZeroAdapter, user, ethereumLzId } = await loadFixture(deployLayerZeroAdapterFixture);
      
      // Try to call lzReceive directly
      await expect(
        layerZeroAdapter.connect(user).lzReceive(
          ethereumLzId,
          "0x",
          0,
          "0x"
        )
      ).to.be.revertedWith("LayerZeroAdapter: Caller is not the endpoint");
    });
    
    it("Should revert if the source address doesn't match trusted remote", async function () {
      const { layerZeroAdapter, mockEndpoint, user, ethereumLzId } = await loadFixture(deployLayerZeroAdapterFixture);
      
      // Try to receive a message with invalid source address
      const invalidSource = ethers.utils.defaultAbiCoder.encode(
        ['address'],
        [user.address] // Not the trusted remote
      );
      
      await expect(
        mockEndpoint.receiveMessage(
          ethereumLzId,
          invalidSource,
          layerZeroAdapter.address,
          1,
          "0x"
        )
      ).to.be.revertedWith("LayerZeroAdapter: Invalid source address");
    });
    
    it("Should emit an event on receiving a message", async function () {
      const { layerZeroAdapter, mockEndpoint, ethereumLzId } = await loadFixture(deployLayerZeroAdapterFixture);
      
      // Get the trusted remote for this chain
      const trustedRemote = await layerZeroAdapter.trustedRemoteLookup(ethereumLzId);
      
      // Create a mock payload (would normally be created by bridgeOut)
      const mockRequest = {
        id: 1,
        srcChainId: 1,
        dstChainId: 1,
        token: ethers.constants.AddressZero,
        amount: 0,
        user: ethers.constants.AddressZero,
        deadline: 0,
        fee: 0
      };
      
      const mockRequestId = ethers.utils.hexZeroPad("0x1", 32);
      
      const payload = ethers.utils.defaultAbiCoder.encode(
        ['tuple(uint256,uint256,uint256,address,uint256,address,uint256,uint256)', 'bytes32'],
        [
          [
            mockRequest.id,
            mockRequest.srcChainId,
            mockRequest.dstChainId,
            mockRequest.token,
            mockRequest.amount,
            mockRequest.user,
            mockRequest.deadline,
            mockRequest.fee
          ],
          mockRequestId
        ]
      );
      
      // Receive the message
      await expect(
        mockEndpoint.receiveMessage(
          ethereumLzId,
          trustedRemote,
          layerZeroAdapter.address,
          1,
          payload
        )
      ).to.emit(layerZeroAdapter, "LayerZeroMessageReceived")
        .withArgs(ethereumLzId, trustedRemote, 1);
    });
  });
  
  describe("Owner functions", function () {
    it("Should allow owner to set chain mapping", async function () {
      const { layerZeroAdapter, owner } = await loadFixture(deployLayerZeroAdapterFixture);
      
      const chainId = 56; // BSC
      const lzId = 102; // Example LayerZero ID
      
      await layerZeroAdapter.connect(owner).setChainMapping(chainId, lzId);
      expect(await layerZeroAdapter.chainToLzId(chainId)).to.equal(lzId);
    });
    
    it("Should allow owner to set trusted remote", async function () {
      const { layerZeroAdapter, owner } = await loadFixture(deployLayerZeroAdapterFixture);
      
      const lzId = 102; // Example LayerZero ID
      const remoteAddress = ethers.utils.defaultAbiCoder.encode(
        ['address'],
        [ethers.Wallet.createRandom().address]
      );
      
      await expect(
        layerZeroAdapter.connect(owner).setTrustedRemote(lzId, remoteAddress)
      ).to.emit(layerZeroAdapter, "TrustedRemoteSet")
        .withArgs(lzId, remoteAddress);
      
      expect(await layerZeroAdapter.trustedRemoteLookup(lzId)).to.equal(remoteAddress);
    });
    
    it("Should allow owner to set adapter parameters", async function () {
      const { layerZeroAdapter, owner } = await loadFixture(deployLayerZeroAdapterFixture);
      
      const newParams = ethers.utils.defaultAbiCoder.encode(
        ['uint16', 'uint256'],
        [1, 300000] // Higher gas limit
      );
      
      await layerZeroAdapter.connect(owner).setAdapterParams(newParams);
      expect(await layerZeroAdapter.adapterParams()).to.equal(newParams);
    });
    
    it("Should allow owner to withdraw ETH", async function () {
      const { layerZeroAdapter, owner } = await loadFixture(deployLayerZeroAdapterFixture);
      
      // Send some ETH to the adapter
      await owner.sendTransaction({
        to: layerZeroAdapter.address,
        value: ethers.utils.parseEther("1.0")
      });
      
      // Get initial balances
      const adapterBalance = await ethers.provider.getBalance(layerZeroAdapter.address);
      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);
      
      // Withdraw ETH
      const amount = ethers.utils.parseEther("0.5");
      const tx = await layerZeroAdapter.connect(owner).withdraw(ethers.constants.AddressZero, amount);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);
      
      // Get final balances
      const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
      
      // Owner should have received the ETH minus gas costs
      expect(ownerBalanceAfter.add(gasUsed).sub(ownerBalanceBefore)).to.equal(amount);
    });
  });
}); 