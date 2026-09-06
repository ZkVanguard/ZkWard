// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SimpleUsdcVault
 * @notice Minimal deposit/withdraw vault for the Hedera demo track.
 *
 * Deliberately small — no AI allocation, no on-chain hedging, no proxy.
 * The SUI-side vault carries the real product; this exists so the Hedera
 * pool has a working deposit/withdraw flow for the prize demo.
 *
 * Share math uses ERC-4626-style virtual offsets to defuse the classic
 * first-depositor inflation attack without a full ERC-4626 dependency.
 *   assets → shares: shares = amount * (T + 1) / (A + 1)
 *   shares → assets: amount = shares * (A + 1) / (T + 1)
 * Where T = totalShares, A = deposit-token balance.
 *
 * All values use the deposit token's decimals (USDC = 6). Shares are 18
 * decimals internally to match ERC-20 UX defaults.
 */
contract SimpleUsdcVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable depositToken;
    uint256 public totalShares;
    uint256 public memberCount;

    mapping(address => uint256) public sharesOf;

    event Deposited(address indexed member, uint256 amount, uint256 shares);
    event Withdrawn(address indexed member, uint256 shares, uint256 amount);

    error ZeroAmount();
    error InsufficientShares();

    constructor(address _depositToken) Ownable(msg.sender) {
        require(_depositToken != address(0), "zero deposit token");
        depositToken = IERC20(_depositToken);
    }

    // ─── Views ──────────────────────────────────────────────────────────
    function totalAssets() public view returns (uint256) {
        return depositToken.balanceOf(address(this));
    }

    /// @notice Human-friendly stats blob for dashboards.
    function getPoolStats()
        external
        view
        returns (
            uint256 _totalShares,
            uint256 _totalNAV,
            uint256 _memberCount,
            uint256 _sharePrice,
            uint256[4] memory _allocations
        )
    {
        _totalShares = totalShares;
        _totalNAV = totalAssets();
        _memberCount = memberCount;
        // Share price = assets per share (scaled by 1e6 to match USDC decimals).
        _sharePrice = totalShares == 0
            ? 1e6
            : (_totalNAV * 1e6) / _totalShares;
        // Deliberately naive — this vault holds USDC only. Reported for
        // frontend compatibility with the SUI pool's schema.
        _allocations = [uint256(10000), 0, 0, 0]; // 100% USDC in BPS
    }

    function getMemberCount() external view returns (uint256) {
        return memberCount;
    }

    // ─── Mutations ──────────────────────────────────────────────────────

    /**
     * Deposit `amount` of the deposit token and receive shares.
     * Follows the standard "transfer-then-record" pattern with a
     * pre-transfer balance snapshot to handle fee-on-transfer tokens
     * (unlikely for USDC but cheap insurance).
     */
    function deposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();

        uint256 before = totalAssets();
        depositToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualDeposit = totalAssets() - before;

        // ERC-4626 virtual-offset share math (1 assetUnit + 1 share).
        shares = (actualDeposit * (totalShares + 1)) / (before + 1);
        require(shares > 0, "zero shares");

        if (sharesOf[msg.sender] == 0) {
            memberCount += 1;
        }
        sharesOf[msg.sender] += shares;
        totalShares += shares;

        emit Deposited(msg.sender, actualDeposit, shares);
    }

    /**
     * Burn `shares` and receive the proportional slice of the vault's
     * assets. Reverts if the caller doesn't own that many shares.
     */
    function withdraw(uint256 shares) external nonReentrant returns (uint256 amount) {
        if (shares == 0) revert ZeroAmount();
        if (sharesOf[msg.sender] < shares) revert InsufficientShares();

        uint256 assets = totalAssets();
        amount = (shares * (assets + 1)) / (totalShares + 1);
        require(amount > 0, "zero payout");

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        if (sharesOf[msg.sender] == 0) {
            memberCount -= 1;
        }

        depositToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, shares, amount);
    }

    // ─── Member position view ──────────────────────────────────────────
    function members(address who)
        external
        view
        returns (
            uint256 shares,
            uint256 depositedUSD,
            uint256 withdrawnUSD,
            uint256 joinTime
        )
    {
        // depositedUSD / withdrawnUSD / joinTime are tracked off-chain
        // for the demo (would inflate storage cost for no on-chain
        // consumer). Frontend already tolerates zero values.
        shares = sharesOf[who];
        depositedUSD = 0;
        withdrawnUSD = 0;
        joinTime = 0;
    }
}
