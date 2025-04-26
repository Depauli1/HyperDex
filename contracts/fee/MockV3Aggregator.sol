// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockV3Aggregator {
    uint8 public decimals;
    int256 public latestAnswer;
    uint80 public latestRoundId;
    uint256 public updatedAt;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        latestAnswer = _initialAnswer;
        latestRoundId = 1;
        updatedAt = block.timestamp;
    }

    function updateAnswer(int256 _answer) external {
        latestAnswer = _answer;
        latestRoundId += 1;
        updatedAt = block.timestamp;
    }

    function latestRoundData()
        external view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt_,
            uint80 answeredInRound
        )
    {
        return (latestRoundId, latestAnswer, block.timestamp, updatedAt, latestRoundId);
    }
}
