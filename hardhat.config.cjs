const { HardhatUserConfig } = require('hardhat/config');
require('@nomicfoundation/hardhat-toolbox');
require('@nomicfoundation/hardhat-verify');
require('@openzeppelin/hardhat-upgrades');
require('hardhat-gas-reporter');
require('hardhat-contract-sizer');
require('solidity-coverage');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });

const config = {
  'ts-node': {
    project: './tsconfig.hardhat.json'
  },
  solidity: {
    // OZ contracts moved to pragma ^0.8.24 in recent versions — need a
    // matching compiler. Kept the 0.8.22 slot for legacy contracts.
    compilers: [
      {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
          evmVersion: 'cancun',
        },
      },
      {
        version: '0.8.22',
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
          evmVersion: 'cancun',
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,  // Enable for testing large contracts
      forking: process.env.FORK_CRONOS
        ? {
            url: process.env.CRONOS_MAINNET_RPC || 'https://evm.cronos.org/',
            blockNumber: parseInt(process.env.FORK_BLOCK_NUMBER || '0'),
          }
        : undefined,
    },
    'cronos-testnet': {
      chainId: 338,
      url: process.env.CRONOS_TESTNET_RPC || 'https://evm-t3.cronos.org/',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 500000000000, // 500 gwei (minimum for testnet)
      timeout: 60000,
    },
    'cronos-mainnet': {
      chainId: 25,
      url: process.env.CRONOS_MAINNET_RPC || 'https://evm.cronos.org/',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 60000,
    },
    'oasis-emerald-testnet': {
      chainId: 42261,
      url: process.env.OASIS_EMERALD_TESTNET_RPC || 'https://testnet.emerald.oasis.io',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 60000,
    },
    'oasis-emerald-mainnet': {
      chainId: 42262,
      url: process.env.OASIS_EMERALD_MAINNET_RPC || 'https://emerald.oasis.io',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 60000,
    },
    'oasis-sapphire-testnet': {
      chainId: 23295,
      url: process.env.OASIS_SAPPHIRE_TESTNET_RPC || 'https://testnet.sapphire.oasis.io',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 60000,
    },
    'oasis-sapphire-mainnet': {
      chainId: 23294,
      url: process.env.OASIS_SAPPHIRE_MAINNET_RPC || 'https://sapphire.oasis.io',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 60000,
    },
    'hedera-testnet': {
      chainId: 296,
      url: process.env.HEDERA_TESTNET_RPC || 'https://testnet.hashio.io/api',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 120000,
    },
    'hedera-mainnet': {
      chainId: 295,
      url: process.env.HEDERA_MAINNET_RPC || 'https://mainnet.hashio.io/api',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 120000,
    },
    'sepolia': {
      chainId: 11155111,
      url: process.env.SEPOLIA_RPC || 'https://sepolia.drpc.org',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 120000,
    },
    'ethereum': {
      chainId: 1,
      url: process.env.ETHEREUM_RPC || 'https://eth.drpc.org',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 120000,
    },
    // duplicate hedera entries removed — using earlier definitions (line ~79)
  },
  etherscan: {
    apiKey: {
      'cronos-testnet': process.env.CRONOSCAN_API_KEY || '',
      'cronos-mainnet': process.env.CRONOSCAN_API_KEY || '',
      'oasis-emerald-testnet': 'no-api-key-needed',
      'oasis-emerald-mainnet': 'no-api-key-needed',
      'oasis-sapphire-testnet': 'no-api-key-needed',
      'oasis-sapphire-mainnet': 'no-api-key-needed',
      'hedera-testnet': process.env.HASHSCAN_API_KEY || '',
      'hedera-mainnet': process.env.HASHSCAN_API_KEY || '',
      'sepolia': process.env.ETHERSCAN_API_KEY || '',
      'ethereum': process.env.ETHERSCAN_API_KEY || '',
    },
    customChains: [
      {
        network: 'cronos-testnet',
        chainId: 338,
        urls: {
          apiURL: 'https://api-testnet.cronoscan.com/api',
          browserURL: 'https://explorer.cronos.org/testnet/',
        },
      },
      {
        network: 'cronos-mainnet',
        chainId: 25,
        urls: {
          apiURL: 'https://api.cronoscan.com/api',
          browserURL: 'https://explorer.cronos.org/',
        },
      },
      {
        network: 'oasis-emerald-testnet',
        chainId: 42261,
        urls: {
          apiURL: 'https://explorer.oasis.io/testnet/emerald/api',
          browserURL: 'https://explorer.oasis.io/testnet/emerald/',
        },
      },
      {
        network: 'oasis-emerald-mainnet',
        chainId: 42262,
        urls: {
          apiURL: 'https://explorer.oasis.io/mainnet/emerald/api',
          browserURL: 'https://explorer.oasis.io/mainnet/emerald/',
        },
      },
      {
        network: 'oasis-sapphire-testnet',
        chainId: 23295,
        urls: {
          apiURL: 'https://explorer.oasis.io/testnet/sapphire/api',
          browserURL: 'https://explorer.oasis.io/testnet/sapphire/',
        },
      },
      {
        network: 'oasis-sapphire-mainnet',
        chainId: 23294,
        urls: {
          apiURL: 'https://explorer.oasis.io/mainnet/sapphire/api',
          browserURL: 'https://explorer.oasis.io/mainnet/sapphire/',
        },
      },
      {
        network: 'hedera-testnet',
        chainId: 296,
        urls: {
          apiURL: 'https://server-verify.hashscan.io/api',
          browserURL: 'https://hashscan.io/testnet/',
        },
      },
      {
        network: 'hedera-mainnet',
        chainId: 295,
        urls: {
          apiURL: 'https://server-verify.hashscan.io/api',
          browserURL: 'https://hashscan.io/mainnet/',
        },
      },
      {
        network: 'sepolia',
        chainId: 11155111,
        urls: {
          apiURL: 'https://api-sepolia.etherscan.io/api',
          browserURL: 'https://sepolia.etherscan.io/',
        },
      },
    ],
  },
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify.dev/server",
    browserUrl: "https://repo.sourcify.dev",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: 'gas-report.txt',
    noColors: true,
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
  },
  paths: {
    sources: './contracts',
    tests: './test/unit/contracts',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: {
    timeout: 120000,
  },
  typechain: {
    outDir: 'typechain-types',
    target: 'ethers-v6',
  },
};

module.exports = config;
