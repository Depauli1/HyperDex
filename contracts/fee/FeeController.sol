// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract FeeController is Ownable, Pausable {
    AggregatorV3Interface public gasPriceFeed;
    uint256 public baseFeeBP;
    uint256 public maxFeeBP;
    uint256[] private history;
    event FeeUpdated(uint256 feeBP, uint256 timestamp);

    constructor(address _gasPriceFeed, uint256 _baseFeeBP, uint256 _maxFeeBP) {
        gasPriceFeed = AggregatorV3Interface(_gasPriceFeed);
        baseFeeBP = _baseFeeBP;
        maxFeeBP = _maxFeeBP;
    }

    function updateFee() external whenNotPaused {
        (, int256 gasPrice,,,) = gasPriceFeed.latestRoundData();
        require(gasPrice > 0, "Invalid gas price");
        uint256 gpGwei = uint256(gasPrice) / 1e9;
        uint256 fee = baseFeeBP + gpGwei;
        if (fee > maxFeeBP) fee = maxFeeBP;
        history.push(fee);
        emit FeeUpdated(fee, block.timestamp);
    }

    function getCurrentFee() external view returns (uint256) {
        if (history.length == 0) return baseFeeBP;
        return history[history.length - 1];
    }

    function getFeeHistory(uint256 start, uint256 end) external view returns (uint256[] memory) {
        require(end > start && end <= history.length, "Invalid indices");
        uint256 len = end - start;
        uint256[] memory out = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = history[start + i];
        }
        return out;
    }

    function setBaseFee(uint256 _baseFeeBP) external onlyOwner {
        baseFeeBP = _baseFeeBP;
    }

    function setMaxFee(uint256 _maxFeeBP) external onlyOwner {
        maxFeeBP = _maxFeeBP;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
