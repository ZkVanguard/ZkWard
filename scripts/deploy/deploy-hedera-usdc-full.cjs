/**
 * Deploy Hedera-testnet USDC-backed CommunityPool in one shot.
 *
 * Steps:
 *   1. Deploy MockERC20 as "USD Coin" (USDC, 6 decimals).
 *   2. Mint 10,000 test USDC to the deployer.
 *   3. Deploy CommunityPool via UUPS proxy, initialised with the new USDC
 *      + real Hedera-testnet Pyth oracle.
 *   4. Print the resulting addresses in a machine-readable block for the
 *      addresses-config sync step.
 *
 * Prereq:
 *   PRIVATE_KEY  — operator wallet with >=0.5 HBAR (deployer)
 *
 * Run:
 *   npx hardhat run scripts/deploy/deploy-hedera-usdc-full.cjs --network hedera-testnet
 */

const { ethers } = require('hardhat');

const NETWORK_NAME = 'Hedera Testnet';
const CHAIN_ID = 296;

// Real Pyth deployment on Hedera testnet (from lib/contracts/addresses.ts).
const HEDERA_PYTH_TESTNET = '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729';

// Deposit token config — 6 decimals matches real Circle USDC.
const USDC_NAME = 'USD Coin';
const USDC_SYMBOL = 'USDC';
const USDC_DECIMALS = 6;
const MINT_HUMAN_UNITS = 10_000; // 10,000 test USDC to deployer

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`   HEDERA USDC POOL — full deploy on ${NETWORK_NAME}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Deployer:', deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:', ethers.formatEther(balance), 'HBAR');
  if (balance < ethers.parseEther('0.5')) {
    throw new Error('Deployer needs >=0.5 HBAR for deploy + init + mint gas');
  }

  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`Expected chainId ${CHAIN_ID}, got ${network.chainId}`);
  }

  // Hedera EVM needs generous fee overrides — Hashio's simulator otherwise
  // rejects with INSUFFICIENT_TX_FEE for proxy deploys.
  const feeOverrides = {
    gasLimit: 15_000_000,
    maxFeePerGas: ethers.parseUnits('20000', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
    type: 2,
  };

  // ─── Step 1: Deploy mock USDC ─────────────────────────────────────────
  console.log('\n🪙  Deploying MockERC20 as USDC (6 decimals)...');
  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const usdc = await MockERC20.deploy(USDC_NAME, USDC_SYMBOL, USDC_DECIMALS, feeOverrides);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log('   USDC address:', usdcAddress);

  // ─── Step 2: Mint test USDC to deployer ───────────────────────────────
  const mintAmount = ethers.parseUnits(String(MINT_HUMAN_UNITS), USDC_DECIMALS);
  console.log(`\n💰 Minting ${MINT_HUMAN_UNITS.toLocaleString()} USDC to deployer...`);
  const mintTx = await usdc.mint(deployer.address, mintAmount, feeOverrides);
  await mintTx.wait();
  const deployerUsdcBalance = await usdc.balanceOf(deployer.address);
  console.log(
    '   Deployer USDC balance:',
    ethers.formatUnits(deployerUsdcBalance, USDC_DECIMALS),
  );

  // ─── Step 3: Deploy SimpleUsdcVault (Hedera demo pool) ────────────────
  // Minimal deposit/withdraw vault. The full AI-managed pool lives on SUI;
  // this one exists so the Hedera track has a working end-to-end flow.
  console.log('\n🏦 Deploying SimpleUsdcVault...');
  const SimpleUsdcVault = await ethers.getContractFactory('SimpleUsdcVault');
  const pool = await SimpleUsdcVault.deploy(usdcAddress, feeOverrides);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log('   Vault:', poolAddress);

  // ─── Step 4: Sanity checks ─────────────────────────────────────────────
  console.log('\n🔍 Sanity checks...');
  const readDepositToken = await pool.depositToken();
  console.log('   pool.depositToken() =', readDepositToken);
  if (readDepositToken.toLowerCase() !== usdcAddress.toLowerCase()) {
    throw new Error('depositToken mismatch — init failed');
  }
  const totalShares = await pool.totalShares();
  console.log('   pool.totalShares()  =', totalShares.toString());
  const implAddress = poolAddress; // not a proxy — impl == deployed contract

  // ─── Output block ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('   DONE — copy the block below into lib/contracts/*');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(JSON.stringify({
    chain: 'hedera',
    network: 'testnet',
    chainId: CHAIN_ID,
    deployer: deployer.address,
    usdc: usdcAddress,
    usdcDecimals: USDC_DECIMALS,
    communityPool: poolAddress,
    communityPoolImplementation: implAddress,
    pythOracle: HEDERA_PYTH_TESTNET,
    mintedToDeployer: MINT_HUMAN_UNITS,
    hashscan: `https://hashscan.io/testnet/contract/${poolAddress}`,
    hashscanUsdc: `https://hashscan.io/testnet/contract/${usdcAddress}`,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
