#!/bin/bash

# Directory containing your contracts
CONTRACT_DIR="contracts"

# Update imports for v3-periphery
find $CONTRACT_DIR -name "*.sol" -type f -exec sed -i 's|import \+["'\'']\./base/|import '"'"'@uniswap/v3-periphery/contracts/base/|g' {} \;
find $CONTRACT_DIR -name "*.sol" -type f -exec sed -i 's|import \+["'\'']\./libraries/|import '"'"'@uniswap/v3-periphery/contracts/libraries/|g' {} \;
find $CONTRACT_DIR -name "*.sol" -type f -exec sed -i 's|import \+["'\'']\./interfaces/|import '"'"'@uniswap/v3-periphery/contracts/interfaces/|g' {} \;

# Update imports for v3-core (if needed)
find $CONTRACT_DIR -name "*.sol" -type f -exec sed -i 's|import \+["'\'']\.\.\/\.\.\/core\/|import '"'"'@uniswap/v3-core/contracts/|g' {} \;
find $CONTRACT_DIR -name "*.sol" -type f -exec sed -i 's|import \+["'\'']\.\./core/|import '"'"'@uniswap/v3-core/contracts/|g' {} \;

echo "Import paths updated!"