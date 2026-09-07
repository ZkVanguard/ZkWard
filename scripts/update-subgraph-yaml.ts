/**
 * Patch subgraph/subgraph.yaml — swap the SimpleUsdcVault placeholder
 * (address 0x0000…0000) with a real deployed address + startBlock.
 *
 * Called by scripts/populate-sepolia-subgraph.sh after
 * deploy-sepolia-usdc-full.cjs completes; also runnable by hand:
 *
 *   bun run scripts/update-subgraph-yaml.ts <address> <startBlock>
 *
 * Deliberately does NOT use a YAML library — we do a targeted line-level
 * substitution against the placeholder block so unrelated whitespace,
 * comments, and formatting are preserved bit-for-bit.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const YAML_PATH = 'subgraph/subgraph.yaml';
const PLACEHOLDER_ADDRESS = '0x0000000000000000000000000000000000000000';

function usage(): never {
  console.error('usage: bun run scripts/update-subgraph-yaml.ts <0xADDRESS> <startBlock>');
  process.exit(1);
}

const [, , addrArg, blockArg] = process.argv;
if (!addrArg || !blockArg) usage();
if (!/^0x[0-9a-fA-F]{40}$/.test(addrArg)) {
  console.error(`ERROR: address is not a valid EVM 20-byte hex: ${addrArg}`);
  process.exit(1);
}
const block = Number(blockArg);
if (!Number.isFinite(block) || block <= 0) {
  console.error(`ERROR: startBlock is not a positive integer: ${blockArg}`);
  process.exit(1);
}

const original = readFileSync(YAML_PATH, 'utf8');

// Find the SimpleUsdcVault data source block and replace the two lines
// (address + startBlock) inside its source: block. This is intentionally
// narrow — we don't touch the CommunityPool block above.
const lines = original.split('\n');
let inSimpleUsdcVault = false;
let inSourceOfSimpleUsdcVault = false;
let addrReplaced = false;
let blockReplaced = false;

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^\s*-\s+kind:\s+ethereum\/contract\b/.test(l)) {
    inSimpleUsdcVault = false;
    inSourceOfSimpleUsdcVault = false;
    // peek forward for name: SimpleUsdcVault within the next few lines
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      if (/^\s+name:\s+SimpleUsdcVault\s*$/.test(lines[j])) { inSimpleUsdcVault = true; break; }
    }
  }
  if (inSimpleUsdcVault && /^\s+source:\s*$/.test(l)) {
    inSourceOfSimpleUsdcVault = true;
    continue;
  }
  if (inSourceOfSimpleUsdcVault && /^\s+mapping:\s*$/.test(l)) {
    inSourceOfSimpleUsdcVault = false;
    inSimpleUsdcVault = false;
    continue;
  }
  if (inSourceOfSimpleUsdcVault) {
    if (/^\s+address:\s+"0x[0-9a-fA-F]{40}"/.test(l)) {
      lines[i] = l.replace(/"0x[0-9a-fA-F]{40}"/, `"${addrArg.toLowerCase()}"`);
      addrReplaced = true;
    }
    if (/^\s+startBlock:\s+\d+/.test(l)) {
      lines[i] = l.replace(/startBlock:\s+\d+/, `startBlock: ${block}`);
      blockReplaced = true;
    }
  }
}

if (!addrReplaced || !blockReplaced) {
  console.error(`ERROR: could not locate SimpleUsdcVault source block in ${YAML_PATH}`);
  console.error(`       addrReplaced=${addrReplaced} blockReplaced=${blockReplaced}`);
  process.exit(1);
}

// Sanity: refuse to write if the previous address wasn't the placeholder
// AND the new address differs — signals someone else already patched it.
if (!original.includes(PLACEHOLDER_ADDRESS)) {
  const already = original.match(/name:\s+SimpleUsdcVault[\s\S]{0,300}?address:\s+"(0x[0-9a-fA-F]{40})"/);
  const currentAddr = already?.[1];
  if (currentAddr && currentAddr.toLowerCase() !== addrArg.toLowerCase()) {
    console.error(`REFUSING to overwrite existing non-placeholder SimpleUsdcVault address ${currentAddr}`);
    console.error(`         (called with ${addrArg}). Reset by hand if this is intentional.`);
    process.exit(1);
  }
}

const patched = lines.join('\n');
writeFileSync(YAML_PATH, patched, 'utf8');

console.log(`✓ ${YAML_PATH} — SimpleUsdcVault: ${addrArg.toLowerCase()} @ block ${block}`);
