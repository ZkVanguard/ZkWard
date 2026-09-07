/**
 * Seed the Sepolia SimpleUsdcVault with realistic activity so the
 * subgraph has real events to index for the demo.
 *
 * Sequence: 6 deposits (varying amounts, one per synthetic "user" account
 * simulated by minting to and depositing from the deployer for each),
 * then 2 withdrawals. Each tx is a real on-chain event the subgraph will
 * pick up within ~30 seconds.
 *
 * All accounts here are the deployer — a real multi-user demo isn't
 * necessary for the "does the subgraph work" story. What matters is
 * that Deposited / Withdrawn events fire with varying amounts.
 *
 * Env required (in .env.local):
 *   PRIVATE_KEY          Sepolia signer
 *   SEPOLIA_USDC_ADDR    from the deploy script's output block
 *   SEPOLIA_VAULT_ADDR   from the deploy script's output block
 *   SEPOLIA_RPC          optional
 *
 * Run:
 *   npx hardhat run scripts/seed-sepolia-vault.cjs --network sepolia
 */

const { ethers } = require('hardhat');

const DEPOSITS_HUMAN_USDC = [50, 125, 300, 500, 1000, 250];
const WITHDRAWS_HUMAN_SHARES = [40, 200];
const USDC_DECIMALS = 6;

async function main() {
  const [signer] = await ethers.getSigners();
  const usdcAddr = (process.env.SEPOLIA_USDC_ADDR || '').trim();
  const vaultAddr = (process.env.SEPOLIA_VAULT_ADDR || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdcAddr) || !/^0x[0-9a-fA-F]{40}$/.test(vaultAddr)) {
    throw new Error('SEPOLIA_USDC_ADDR and SEPOLIA_VAULT_ADDR must be set in .env.local');
  }
  console.log('Signer:', signer.address);
  console.log('USDC:  ', usdcAddr);
  console.log('Vault: ', vaultAddr);

  const usdc = await ethers.getContractAt(
    ['function approve(address,uint256) external returns (bool)',
     'function balanceOf(address) external view returns (uint256)',
     'function mint(address,uint256) external'],
    usdcAddr,
    signer,
  );
  const vault = await ethers.getContractAt(
    ['function deposit(uint256) external returns (uint256)',
     'function withdraw(uint256) external returns (uint256)',
     'function totalShares() external view returns (uint256)',
     'function totalAssets() external view returns (uint256)'],
    vaultAddr,
    signer,
  );

  // ─── Ensure signer holds enough USDC for the whole run ─────────────────
  const totalHuman = DEPOSITS_HUMAN_USDC.reduce((a, b) => a + b, 0);
  const totalNeeded = ethers.parseUnits(String(totalHuman), USDC_DECIMALS);
  const currentBalance = await usdc.balanceOf(signer.address);
  if (currentBalance < totalNeeded) {
    const mintAmount = totalNeeded - currentBalance;
    console.log(`Minting ${ethers.formatUnits(mintAmount, USDC_DECIMALS)} extra USDC to cover run...`);
    const tx = await usdc.mint(signer.address, mintAmount);
    await tx.wait();
  }

  // ─── One-shot approve of the max we'll need ────────────────────────────
  console.log('\nApproving vault to spend...');
  const approveTx = await usdc.approve(vaultAddr, totalNeeded);
  await approveTx.wait();

  // ─── Deposits ──────────────────────────────────────────────────────────
  for (let i = 0; i < DEPOSITS_HUMAN_USDC.length; i++) {
    const human = DEPOSITS_HUMAN_USDC[i];
    const amount = ethers.parseUnits(String(human), USDC_DECIMALS);
    process.stdout.write(`  deposit #${i + 1}: ${human} USDC ... `);
    const tx = await vault.deposit(amount);
    const receipt = await tx.wait();
    console.log(`✓ tx ${tx.hash.slice(0, 12)}… block ${receipt.blockNumber}`);
  }

  // ─── Withdrawals ───────────────────────────────────────────────────────
  for (let i = 0; i < WITHDRAWS_HUMAN_SHARES.length; i++) {
    const shares = ethers.parseUnits(String(WITHDRAWS_HUMAN_SHARES[i]), USDC_DECIMALS);
    process.stdout.write(`  withdraw #${i + 1}: ${WITHDRAWS_HUMAN_SHARES[i]} shares ... `);
    const tx = await vault.withdraw(shares);
    const receipt = await tx.wait();
    console.log(`✓ tx ${tx.hash.slice(0, 12)}… block ${receipt.blockNumber}`);
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────
  const totalShares = await vault.totalShares();
  const totalAssets = await vault.totalAssets();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Vault final state:`);
  console.log(`    totalAssets: ${ethers.formatUnits(totalAssets, USDC_DECIMALS)} USDC`);
  console.log(`    totalShares: ${ethers.formatUnits(totalShares, USDC_DECIMALS)}`);
  console.log(`    sharePrice:  ${totalShares === 0n ? '1.000000' : (Number(totalAssets) / Number(totalShares)).toFixed(6)}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
