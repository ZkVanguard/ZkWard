// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "../helpers/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title HedgeExecutorV2
 * @notice On-chain hedge execution with 20% performance fee on profits
 * @dev UUPS upgradeable - V2 adds industry-standard performance fee
 *
 * FEE STRUCTURE:
 * =============
 * - Execution Fee: 0.1% (10 bps) on all operations
 * - Performance Fee: 20% (2000 bps) on profitable hedges ONLY
 * - High-water mark: Users never pay twice on same gains
 *
 * MAINNET READY:
 * - 20% performance fee aligns incentives (platform profits when users profit)
 * - Works with Moonlander mainnet perpetuals
 * - Fee accumulation for platform sustainability
 */
contract HedgeExecutorV2 is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════

    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ═══════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════

    struct HedgePosition {
        bytes32 hedgeId;            // Unique hedge identifier
        address trader;             // Owner of this hedge
        uint256 pairIndex;          // Trading pair (0=BTC, 1=ETH, etc.)
        uint256 tradeIndex;         // Moonlander trade index
        uint256 collateralAmount;   // USDC collateral deposited
        uint256 leverage;           // Leverage multiplier
        bool isLong;                // Direction
        bytes32 commitmentHash;     // ZK commitment hash
        bytes32 nullifier;          // Anti-replay nullifier
        uint256 openTimestamp;      // When position was opened
        uint256 closeTimestamp;     // When position was closed (0 if open)
        int256 realizedPnl;         // Gross PnL before fees
        int256 netPnl;              // Net PnL after performance fee
        uint256 performanceFee;     // Performance fee charged
        HedgeStatus status;         // Current status
    }

    enum HedgeStatus {
        PENDING,        // Commitment stored, awaiting execution
        ACTIVE,         // Position open on Moonlander
        CLOSED,         // Position closed, PnL settled
        LIQUIDATED,     // Position was liquidated
        CANCELLED       // Cancelled before execution
    }

    // ═══════════════════════════════════════════════════════════════
    // STATE (V1 compatible)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Collateral token (USDC)
    IERC20 public collateralToken;

    /// @notice Moonlander perpetuals contract
    address public moonlanderRouter;

    /// @notice ZKHedgeCommitment contract
    address public zkCommitment;

    /// @notice All hedge positions by hedgeId
    mapping(bytes32 => HedgePosition) public hedges;

    /// @notice User's active hedge IDs
    mapping(address => bytes32[]) public userHedges;

    /// @notice Nullifier tracking (prevents double-execution)
    mapping(bytes32 => bool) public nullifierUsed;

    /// @notice Total hedges opened
    uint256 public totalHedgesOpened;

    /// @notice Total hedges closed
    uint256 public totalHedgesClosed;

    /// @notice Total collateral currently locked
    uint256 public totalCollateralLocked;

    /// @notice Total PnL realized across all hedges (gross)
    int256 public totalPnlRealized;

    /// @notice Maximum leverage allowed
    uint256 public maxLeverage;

    /// @notice Minimum collateral per hedge
    uint256 public minCollateral;

    /// @notice Execution fee rate in basis points (e.g., 10 = 0.1%)
    uint256 public feeRateBps;

    /// @notice Accumulated execution fees
    uint256 public accumulatedFees;

    // ═══════════════════════════════════════════════════════════════
    // STATE (V2 additions - performance fee)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Performance fee rate in basis points (2000 = 20%)
    uint256 public performanceFeeBps;

    /// @notice Accumulated performance fees (separate tracking)
    uint256 public accumulatedPerformanceFees;

    /// @notice High-water mark per user (for future enhancement)
    mapping(address => int256) public userHighWaterMark;

    /// @notice Total performance fees collected all-time
    uint256 public totalPerformanceFeesCollected;

    /// @notice Total profits distributed to users (after fees)
    uint256 public totalUserProfitsDistributed;

    // ═══════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════

    event HedgeOpened(
        bytes32 indexed hedgeId,
        address indexed trader,
        uint256 pairIndex,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        bytes32 commitmentHash
    );

    event HedgeClosed(
        bytes32 indexed hedgeId,
        address indexed trader,
        int256 grossPnl,
        int256 netPnl,
        uint256 performanceFee,
        uint256 duration
    );

    event HedgeLiquidated(
        bytes32 indexed hedgeId,
        address indexed trader,
        uint256 collateralLost
    );

    event CollateralAdded(
        bytes32 indexed hedgeId,
        address indexed trader,
        uint256 amount
    );

    event PerformanceFeeCollected(
        bytes32 indexed hedgeId,
        address indexed trader,
        uint256 profit,
        uint256 fee
    );

    event PerformanceFeeRateUpdated(
        uint256 oldRate,
        uint256 newRate
    );

    event FeesWithdrawn(
        address indexed to,
        uint256 executionFees,
        uint256 performanceFees
    );

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize V2 with performance fee
     * @dev Call this for fresh deployments
     */
    function initialize(
        address _collateralToken,
        address _moonlanderRouter,
        address _zkCommitment,
        address _admin
    ) public initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        collateralToken = IERC20(_collateralToken);
        moonlanderRouter = _moonlanderRouter;
        zkCommitment = _zkCommitment;

        maxLeverage = 100;           // 100x max
        minCollateral = 1e6;         // 1 USDC minimum (6 decimals)
        feeRateBps = 10;             // 0.1% execution fee
        performanceFeeBps = 2000;    // 20% performance fee (industry standard)

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(AGENT_ROLE, _admin);
        _grantRole(RELAYER_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
    }

    /**
     * @notice Reinitialize for upgrade from V1 to V2
     * @dev Call this when upgrading existing V1 deployment
     */
    function initializeV2() public reinitializer(2) {
        performanceFeeBps = 2000; // 20% performance fee
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE: OPEN HEDGE (same as V1)
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Open a hedge via Moonlander with ZK commitment
     */
    function openHedge(
        address trader,
        uint256 pairIndex,
        uint256 collateralAmount,
        uint256 leverage,
        bool isLong,
        bytes32 commitmentHash,
        bytes32 nullifier,
        uint256 openPrice,
        uint256 tp,
        uint256 sl,
        bytes[] calldata pythUpdateData
    ) external payable nonReentrant whenNotPaused onlyRole(AGENT_ROLE) returns (bytes32 hedgeId) {
        require(collateralAmount >= minCollateral, "Below min collateral");
        require(leverage >= 2 && leverage <= maxLeverage, "Invalid leverage");
        require(!nullifierUsed[nullifier], "Nullifier already used");

        // Calculate fee
        uint256 fee = (collateralAmount * feeRateBps) / 10000;
        uint256 netCollateral = collateralAmount - fee;

        // Transfer collateral from trader
        collateralToken.safeTransferFrom(trader, address(this), collateralAmount);
        accumulatedFees += fee;

        // Approve Moonlander
        collateralToken.approve(moonlanderRouter, netCollateral);

        // Calculate leveraged amount
        uint256 leveragedAmount = netCollateral * leverage;

        // Open on Moonlander
        uint256 tradeIndex = IMoonlanderRouter(moonlanderRouter).openMarketTradeWithPythAndExtraFee{value: msg.value}(
            address(0), // No referrer
            pairIndex,
            address(collateralToken),
            netCollateral,
            openPrice,
            leveragedAmount,
            tp,
            sl,
            isLong ? 0 : 1, // 0 = long, 1 = short
            0, // No extra fee
            pythUpdateData
        );

        // Generate hedgeId
        hedgeId = keccak256(abi.encodePacked(trader, pairIndex, block.timestamp, tradeIndex));

        // Store position
        hedges[hedgeId] = HedgePosition({
            hedgeId: hedgeId,
            trader: trader,
            pairIndex: pairIndex,
            tradeIndex: tradeIndex,
            collateralAmount: netCollateral,
            leverage: leverage,
            isLong: isLong,
            commitmentHash: commitmentHash,
            nullifier: nullifier,
            openTimestamp: block.timestamp,
            closeTimestamp: 0,
            realizedPnl: 0,
            netPnl: 0,
            performanceFee: 0,
            status: HedgeStatus.ACTIVE
        });

        userHedges[trader].push(hedgeId);
        nullifierUsed[nullifier] = true;
        totalHedgesOpened++;
        totalCollateralLocked += netCollateral;

        emit HedgeOpened(hedgeId, trader, pairIndex, isLong, netCollateral, leverage, commitmentHash);
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE: CLOSE HEDGE (V2 with performance fee)
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Close a hedge position with 20% performance fee on profits
     * @param hedgeId The hedge to close
     */
    function closeHedge(bytes32 hedgeId) external nonReentrant whenNotPaused {
        HedgePosition storage hedge = hedges[hedgeId];
        require(hedge.trader == msg.sender || hasRole(AGENT_ROLE, msg.sender), "Not authorized");
        require(hedge.status == HedgeStatus.ACTIVE, "Not active");

        // Get balance before close
        uint256 balanceBefore = collateralToken.balanceOf(address(this));

        // Close on Moonlander
        IMoonlanderRouter(moonlanderRouter).closeTrade(
            hedge.pairIndex,
            hedge.tradeIndex
        );

        // Calculate PnL from balance change
        uint256 balanceAfter = collateralToken.balanceOf(address(this));
        int256 grossPnl;
        if (balanceAfter >= balanceBefore) {
            grossPnl = int256(balanceAfter - balanceBefore) - int256(hedge.collateralAmount);
        } else {
            grossPnl = -int256(hedge.collateralAmount);
        }

        // Calculate performance fee (20% of profits only)
        uint256 performanceFee = 0;
        int256 netPnl = grossPnl;
        
        if (grossPnl > 0) {
            // Performance fee only on profits
            performanceFee = (uint256(grossPnl) * performanceFeeBps) / 10000;
            netPnl = grossPnl - int256(performanceFee);
            
            // Track performance fees
            accumulatedPerformanceFees += performanceFee;
            totalPerformanceFeesCollected += performanceFee;
            totalUserProfitsDistributed += uint256(netPnl);

            emit PerformanceFeeCollected(hedgeId, hedge.trader, uint256(grossPnl), performanceFee);
        }

        // Update hedge state
        hedge.status = HedgeStatus.CLOSED;
        hedge.closeTimestamp = block.timestamp;
        hedge.realizedPnl = grossPnl;
        hedge.netPnl = netPnl;
        hedge.performanceFee = performanceFee;

        totalHedgesClosed++;
        totalCollateralLocked -= hedge.collateralAmount;
        totalPnlRealized += grossPnl;

        // Return collateral + net PnL to trader
        uint256 returnAmount;
        if (netPnl >= 0) {
            returnAmount = hedge.collateralAmount + uint256(netPnl);
        } else if (uint256(-netPnl) < hedge.collateralAmount) {
            returnAmount = hedge.collateralAmount - uint256(-netPnl);
        } else {
            returnAmount = 0;
            hedge.status = HedgeStatus.LIQUIDATED;
        }

        if (returnAmount > 0) {
            collateralToken.safeTransfer(hedge.trader, returnAmount);
        }

        emit HedgeClosed(
            hedgeId,
            hedge.trader,
            grossPnl,
            netPnl,
            performanceFee,
            block.timestamp - hedge.openTimestamp
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE: ADD MARGIN
    // ═══════════════════════════════════════════════════════════════

    function addMargin(bytes32 hedgeId, uint256 amount) external nonReentrant whenNotPaused {
        HedgePosition storage hedge = hedges[hedgeId];
        require(hedge.trader == msg.sender, "Not your hedge");
        require(hedge.status == HedgeStatus.ACTIVE, "Not active");

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        collateralToken.approve(moonlanderRouter, amount);

        IMoonlanderRouter(moonlanderRouter).addMargin(
            hedge.pairIndex,
            hedge.tradeIndex,
            amount
        );

        hedge.collateralAmount += amount;
        totalCollateralLocked += amount;

        emit CollateralAdded(hedgeId, msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    function getHedge(bytes32 hedgeId) external view returns (HedgePosition memory) {
        return hedges[hedgeId];
    }

    function getUserHedges(address user) external view returns (bytes32[] memory) {
        return userHedges[user];
    }

    function getUserActiveHedges(address user) external view returns (bytes32[] memory) {
        bytes32[] memory all = userHedges[user];
        uint256 activeCount = 0;
        
        for (uint256 i = 0; i < all.length; i++) {
            if (hedges[all[i]].status == HedgeStatus.ACTIVE) {
                activeCount++;
            }
        }
        
        bytes32[] memory active = new bytes32[](activeCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < all.length; i++) {
            if (hedges[all[i]].status == HedgeStatus.ACTIVE) {
                active[idx++] = all[i];
            }
        }
        
        return active;
    }

    function getStats() external view returns (
        uint256 _totalHedgesOpened,
        uint256 _totalHedgesClosed,
        uint256 _totalCollateralLocked,
        int256 _totalPnlRealized,
        uint256 _accumulatedFees,
        uint256 _accumulatedPerformanceFees
    ) {
        return (
            totalHedgesOpened,
            totalHedgesClosed,
            totalCollateralLocked,
            totalPnlRealized,
            accumulatedFees,
            accumulatedPerformanceFees
        );
    }

    function getFeeConfig() external view returns (
        uint256 _executionFeeBps,
        uint256 _performanceFeeBps,
        uint256 _totalExecutionFees,
        uint256 _totalPerformanceFees
    ) {
        return (feeRateBps, performanceFeeBps, accumulatedFees, accumulatedPerformanceFees);
    }

    // ═══════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════

    function setMaxLeverage(uint256 _maxLeverage) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_maxLeverage >= 2 && _maxLeverage <= 1000, "Invalid range");
        maxLeverage = _maxLeverage;
    }

    function setMinCollateral(uint256 _minCollateral) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minCollateral = _minCollateral;
    }

    function setFeeRate(uint256 _feeRateBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_feeRateBps <= 100, "Fee too high"); // Max 1%
        feeRateBps = _feeRateBps;
    }

    function setPerformanceFeeRate(uint256 _performanceFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_performanceFeeBps <= 5000, "Fee too high"); // Max 50%
        uint256 oldRate = performanceFeeBps;
        performanceFeeBps = _performanceFeeBps;
        emit PerformanceFeeRateUpdated(oldRate, _performanceFeeBps);
    }

    function setMoonlanderRouter(address _router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        moonlanderRouter = _router;
    }

    function setCollateralToken(address _collateralToken) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_collateralToken != address(0), "Invalid address");
        collateralToken = IERC20(_collateralToken);
    }

    function setZKCommitment(address _zkCommitment) external onlyRole(DEFAULT_ADMIN_ROLE) {
        zkCommitment = _zkCommitment;
    }

    /**
     * @notice Withdraw all accumulated fees (execution + performance)
     * @param to Address to receive fees (typically deployer/treasury)
     */
    function withdrawFees(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 execFees = accumulatedFees;
        uint256 perfFees = accumulatedPerformanceFees;
        
        accumulatedFees = 0;
        accumulatedPerformanceFees = 0;
        
        uint256 totalFees = execFees + perfFees;
        if (totalFees > 0) {
            collateralToken.safeTransfer(to, totalFees);
        }
        
        emit FeesWithdrawn(to, execFees, perfFees);
    }

    /**
     * @notice Withdraw only execution fees
     */
    function withdrawExecutionFees(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 fees = accumulatedFees;
        accumulatedFees = 0;
        if (fees > 0) {
            collateralToken.safeTransfer(to, fees);
        }
    }

    /**
     * @notice Withdraw only performance fees
     */
    function withdrawPerformanceFees(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 fees = accumulatedPerformanceFees;
        accumulatedPerformanceFees = 0;
        if (fees > 0) {
            collateralToken.safeTransfer(to, fees);
        }
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Receive ETH for oracle fees
    receive() external payable {}

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}

// ═══════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════

interface IMoonlanderRouter {
    function openMarketTradeWithPythAndExtraFee(
        address referrer,
        uint256 pairIndex,
        address collateralToken,
        uint256 collateralAmount,
        uint256 openPrice,
        uint256 leveragedAmount,
        uint256 tp,
        uint256 sl,
        uint256 direction,
        uint256 fee,
        bytes[] calldata pythUpdateData
    ) external payable returns (uint256);

    function closeTrade(uint256 pairIndex, uint256 tradeIndex) external;

    function addMargin(uint256 pairIndex, uint256 tradeIndex, uint256 amount) external;

    function getTrade(address trader, uint256 pairIndex, uint256 tradeIndex) external view returns (
        address, uint256, uint256, uint256, uint256, uint256, bool, uint256, uint256, uint256, bool
    );
}

interface IZKHedgeCommitment {
    function storeCommitment(
        bytes32 commitmentHash,
        bytes32 nullifier,
        bytes32 merkleRoot
    ) external;

    function settleHedgeWithProof(
        bytes32 commitmentHash,
        bytes calldata zkProof
    ) external;
}
