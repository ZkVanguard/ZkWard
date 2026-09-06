/**
 * Seed the Hedera testnet SimpleUsdcVault with realistic deposit /
 * withdraw activity so the dashboard shows real chain history instead of
 * the SUI fallback.
 *
 * All txs are REAL — this is a Hedera testnet script. Uses the operator
 * wallet (HEDERA_OPERATOR_KEY) to deposit USDC into the vault, then
 * mints extra USDC into the vault outside the deposit path to simulate
 * yield (share price rises), then withdraws a fraction. Result: Mirror
 * Node picks up 5-10 Deposit + 2 Withdraw events, NAV chart populates,
 * memberCount + totalAssets + sharePrice all move.
 *
 * Prereqs:
 *   PRIVATE_KEY = operator ECDSA hex key (0x...)
 *   Operator wallet has HBAR for gas + USDC (mint from faucet if needed)
 *
 * Run:
 *   PRIVATE_KEY=0x... node scripts/seed-hedera-pool.cjs
 */

const { ethers } = require('ethers');

const RPC = process.env.HEDERA_TESTNET_RPC_URL || 'https://testnet.hashio.io/api';
const USDC = '0x704365B35AeF0b7F9fc17c18B5162D4A6d600ae1';
const VAULT = '0xe7E6fEDce9d72D112137B631E8D51831D30729A9';
const USDC_DECIMALS = 6;

// Sequence: 5 deposits, 2 yield injections, 2 withdrawals.
// Each ~10s apart so Mirror Node's ~2-4s indexer catches each cleanly.
// Second-pass sequence — first pass already landed 5 deposits + 2 yield
// injections; here we top up + get the withdraws to actually settle with
// the correct 6-decimal share space.
const SEQUENCE = [
  { kind: 'deposit', amount: 50 },
  { kind: 'withdraw', amount: 40 },   // shares in 6-decimal (~USDC units)
  { kind: 'yield',   amount: 2.0 },
  { kind: 'deposit', amount: 120 },
  { kind: 'withdraw', amount: 25 },
  { kind: 'deposit', amount: 90 },
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function mint(address to, uint256 amount) external',
];

const VAULT_ABI = [
  'function deposit(uint256 amount) external returns (uint256)',
  'function withdraw(uint256 shares) external returns (uint256)',
  'function totalAssets() external view returns (uint256)',
  'function totalShares() external view returns (uint256)',
  'function sharesOf(address who) external view returns (uint256)',
];

// Hedera EVM fee overrides — Hashio simulator otherwise complains.
const FEE = {
  gasLimit: 500_000,
  maxFeePerGas: ethers.parseUnits('20000', 'gwei'),
  maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
  type: 2,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error('PRIVATE_KEY env required');

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(key, provider);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

  console.log(`\n== Seed Hedera testnet vault ==`);
  console.log(`  wallet: ${wallet.address}`);
  console.log(`  vault:  ${VAULT}`);
  console.log(`  usdc:   ${USDC}\n`);

  const startBal = await usdc.balanceOf(wallet.address);
  console.log(`  starting USDC balance: ${ethers.formatUnits(startBal, USDC_DECIMALS)}`);

  // Ensure enough USDC. Deposits sum to ~$665 + yield injections $8.5.
  // Mint an extra $1000 to keep buffer.
  console.log(`\n  minting 1000 USDC to seed operator wallet...`);
  const mintTx = await usdc.mint(wallet.address, ethers.parseUnits('1000', USDC_DECIMALS), FEE);
  await mintTx.wait(1);
  console.log(`    ok: ${mintTx.hash.slice(0, 12)}...`);

  // Blanket allowance so deposits don't require per-tx approve.
  console.log(`\n  approving vault for 100000 USDC...`);
  const apTx = await usdc.approve(VAULT, ethers.parseUnits('100000', USDC_DECIMALS), FEE);
  await apTx.wait(1);
  console.log(`    ok: ${apTx.hash.slice(0, 12)}...`);

  for (let i = 0; i < SEQUENCE.length; i++) {
    const step = SEQUENCE[i];
    console.log(`\n  [${i + 1}/${SEQUENCE.length}] ${step.kind} ${step.amount}`);
    try {
      let tx;
      if (step.kind === 'deposit') {
        const amountWei = ethers.parseUnits(String(step.amount), USDC_DECIMALS);
        tx = await vault.deposit(amountWei, FEE);
      } else if (step.kind === 'yield') {
        // Simulate yield: mint USDC directly to the vault. totalAssets
        // rises, totalShares unchanged → sharePrice rises. Doesn't
        // emit a Deposit event so it won't show in event history, but
        // getPoolStats + on-chain reads will reflect it.
        const amountWei = ethers.parseUnits(String(step.amount), USDC_DECIMALS);
        tx = await usdc.mint(VAULT, amountWei, FEE);
      } else if (step.kind === 'withdraw') {
        // Withdraw amount is in shares. SimpleUsdcVault stores shares
        // in the same 6-decimal space as USDC (contract math preserves
        // asset decimals), not 18. Interpret amount as human-scale shares.
        const sharesWei = ethers.parseUnits(String(step.amount), 6);
        tx = await vault.withdraw(sharesWei, FEE);
      }
      const receipt = await tx.wait(1);
      console.log(`    tx: https://hashscan.io/testnet/transaction/${receipt.hash}`);
    } catch (e) {
      console.warn(`    FAILED: ${(e.message || String(e)).slice(0, 160)}`);
    }
    // Space txs out — Mirror Node indexer catches up in ~2-4s.
    await sleep(6000);
  }

  console.log(`\n  final vault state:`);
  const [ta, ts, mine] = await Promise.all([
    vault.totalAssets(),
    vault.totalShares(),
    vault.sharesOf(wallet.address),
  ]);
  console.log(`    totalAssets  : ${ethers.formatUnits(ta, USDC_DECIMALS)} USDC`);
  console.log(`    totalShares  : ${ethers.formatUnits(ts, 6)}`);
  console.log(`    my shares    : ${ethers.formatUnits(mine, 6)}`);
  const sharePrice = ts === 0n ? 1 :
    (Number(ethers.formatUnits(ta, USDC_DECIMALS)) + 1e-6) /
    (Number(ethers.formatUnits(ts, 6)) + 1e-6);
  console.log(`    share price  : $${sharePrice.toFixed(6)}`);

  console.log(`\n  Mirror-node view (allow 10s for indexer to catch up):`);
  console.log(`    https://hashscan.io/testnet/contract/${VAULT}`);
  console.log(`\n  NAV chart: https://www.zkward.com/dashboard  → Pool tab → Hedera`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
