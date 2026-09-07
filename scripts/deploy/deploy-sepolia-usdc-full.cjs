/**
 * Deploy Sepolia-testnet USDC-backed SimpleUsdcVault in one shot.
 *
 * Mirror of scripts/deploy/deploy-hedera-usdc-full.cjs — same contract,
 * different chain. The point: identical SimpleUsdcVault code runs on
 * both Sepolia and Hedera. The Graph subgraph indexes Sepolia; Hedera
 * Mirror Node adapter projects Hedera into the same schema. One codebase,
 * two settlement venues, one unified query surface.
 *
 * Steps:
 *   1. Deploy MockERC20 as "USD Coin" (USDC, 6 decimals).
 *   2. Mint 10,000 test USDC to the deployer.
 *   3. Deploy SimpleUsdcVault, initialised with the new USDC.
 *   4. Print the resulting addresses in a machine-readable block.
 *
 * Prereq:
 *   PRIVATE_KEY  — Sepolia deployer with >= 0.05 SepETH
 *   SEPOLIA_RPC  — optional override; defaults to sepolia.drpc.org
 *
 * Run:
 *   npx hardhat run scripts/deploy/deploy-sepolia-usdc-full.cjs --network sepolia
 */

const { ethers } = require('hardhat');

const NETWORK_NAME = 'Sepolia';
const CHAIN_ID = 11155111;

const USDC_NAME = 'USD Coin';
const USDC_SYMBOL = 'USDC';
const USDC_DECIMALS = 6;
const MINT_HUMAN_UNITS = 10_000;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`   SEPOLIA USDC POOL — full deploy on ${NETWORK_NAME}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Deployer:', deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');
  if (balance < ethers.parseEther('0.02')) {
    throw new Error('Deployer needs >= 0.02 SepETH for deploy + mint gas');
  }

  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`Expected chainId ${CHAIN_ID}, got ${network.chainId}`);
  }

  // Sepolia uses standard EIP-1559 pricing — no exotic overrides needed.

  // ─── Step 1: Deploy mock USDC ─────────────────────────────────────────
  console.log('\n🪙  Deploying MockERC20 as USDC (6 decimals)...');
  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const usdc = await MockERC20.deploy(USDC_NAME, USDC_SYMBOL, USDC_DECIMALS);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  const usdcTx = usdc.deploymentTransaction();
  const usdcReceipt = usdcTx ? await usdcTx.wait() : null;
  console.log('   USDC address:', usdcAddress, '(block', usdcReceipt?.blockNumber, ')');

  // ─── Step 2: Mint test USDC to deployer ───────────────────────────────
  const mintAmount = ethers.parseUnits(String(MINT_HUMAN_UNITS), USDC_DECIMALS);
  console.log(`\n💰 Minting ${MINT_HUMAN_UNITS.toLocaleString()} USDC to deployer...`);
  const mintTx = await usdc.mint(deployer.address, mintAmount);
  await mintTx.wait();
  const deployerUsdcBalance = await usdc.balanceOf(deployer.address);
  console.log(
    '   Deployer USDC balance:',
    ethers.formatUnits(deployerUsdcBalance, USDC_DECIMALS),
  );

  // ─── Step 3: Deploy SimpleUsdcVault ───────────────────────────────────
  console.log('\n🏦 Deploying SimpleUsdcVault...');
  const SimpleUsdcVault = await ethers.getContractFactory('SimpleUsdcVault');
  const pool = await SimpleUsdcVault.deploy(usdcAddress);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  const poolTx = pool.deploymentTransaction();
  const poolReceipt = poolTx ? await poolTx.wait() : null;
  console.log('   Vault:', poolAddress, '(block', poolReceipt?.blockNumber, ')');

  // ─── Step 4: Sanity ────────────────────────────────────────────────────
  const readDepositToken = await pool.depositToken();
  if (readDepositToken.toLowerCase() !== usdcAddress.toLowerCase()) {
    throw new Error('depositToken mismatch — init failed');
  }
  console.log('   pool.depositToken() =', readDepositToken, '✓');

  // ─── Output block ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('   DONE — subgraph startBlock =', poolReceipt?.blockNumber ?? usdcReceipt?.blockNumber);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(JSON.stringify({
    chain: 'sepolia',
    network: 'testnet',
    chainId: CHAIN_ID,
    deployer: deployer.address,
    usdc: usdcAddress,
    usdcDeployBlock: usdcReceipt?.blockNumber,
    usdcDecimals: USDC_DECIMALS,
    communityPool: poolAddress,
    communityPoolImplementation: poolAddress,
    poolDeployBlock: poolReceipt?.blockNumber,
    mintedToDeployer: MINT_HUMAN_UNITS,
    etherscan: `https://sepolia.etherscan.io/address/${poolAddress}`,
    etherscanUsdc: `https://sepolia.etherscan.io/address/${usdcAddress}`,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
