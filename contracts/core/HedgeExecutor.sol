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
 * @title HedgeExecutor
 * @notice On-chain hedge execution engine that bridges ZKHedgeCommitment and Moonlander
 * @dev Executes perpetual hedges on-chain with ZK privacy commitments in a single atomic tx
 *
 * ARCHITECTURE:
 * =============
 * Agent → HedgeExecutor.sol → PerpetualDEX.sol     (on-chain positions)
 *                            → ZKHedgeCommitment.sol (on-chain ZK proofs)
 *
 * Each hedge:
 * 1. Opens a perpetual position on Moonlander (on-chain)
 * 2. Stores a ZK commitment hash (privacy-preserving)
 * 3. Links them via hedgeId for atomic settlement
 *
 * MAINNET READY:
 * - UUPS upgradeable for post-deployment fixes
 * - AccessControl for role-based permissions
 * - ReentrancyGuard for safe external calls
 * - Pausable for emergency stops
 * - Collateral held in this contract (not user wallets)
 */
contract HedgeExecutor is
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
        int256 realizedPnl;         // PnL after close
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
    // STATE
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

    /// @notice Total PnL realized across all hedges
    int256 public totalPnlRealized;

    /// @notice Maximum leverage allowed
    uint256 public maxLeverage;

    /// @notice Minimum collateral per hedge
    uint256 public minCollateral;

    /// @notice Fee rate in basis points (e.g., 10 = 0.1%)
    uint256 public feeRateBps;

    /// @notice Accumulated protocol fees
    uint256 public accumulatedFees;

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
        int256 pnl,
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

    event EmergencyClose(
        bytes32 indexed hedgeId,
        address indexed closedBy,
        string reason
    );

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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

        maxLeverage = 100;          // 100x max
        minCollateral = 1e6;        // 1 USDC minimum (6 decimals)
        feeRateBps = 10;            // 0.1% fee

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(AGENT_ROLE, _admin);
        _grantRole(RELAYER_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE: OPEN HEDGE
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Open a hedge position atomically (on-chain perp + ZK commitment)
     * @param pairIndex Trading pair (0=BTC, 1=ETH, 2=CRO, etc.)
     * @param collateralAmount USDC collateral to deposit
     * @param leverage Leverage multiplier (2-100x)
     * @param isLong Direction (true=long, false=short for hedging)
     * @param commitmentHash ZK commitment: H(asset || side || size || salt)
     * @param nullifier Unique nullifier to prevent double-execution
     * @param merkleRoot Optional merkle root for batch verification
     * @return hedgeId Unique identifier for this hedge
     */
    function openHedge(
        uint256 pairIndex,
        uint256 collateralAmount,
        uint256 leverage,
        bool isLong,
        bytes32 commitmentHash,
        bytes32 nullifier,
        bytes32 merkleRoot
    ) external payable nonReentrant whenNotPaused returns (bytes32 hedgeId) {
        require(msg.value >= 0.06 ether, "Insufficient oracle fee");
        // Validation
        require(collateralAmount >= minCollateral, "Below min collateral");
        require(leverage >= 2 && leverage <= maxLeverage, "Invalid leverage");
        require(commitmentHash != bytes32(0), "Invalid commitment");
        require(nullifier != bytes32(0), "Invalid nullifier");
        require(!nullifierUsed[nullifier], "Nullifier already used");

        // Generate unique hedge ID
        hedgeId = keccak256(abi.encodePacked(
            msg.sender,
            pairIndex,
            collateralAmount,
            block.timestamp,
            totalHedgesOpened
        ));

        // Calculate fee
        uint256 fee = (collateralAmount * feeRateBps) / 10000;
        uint256 netCollateral = collateralAmount - fee;

        // Transfer collateral from user
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        accumulatedFees += fee;

        // Approve Moonlander to spend collateral
        collateralToken.approve(moonlanderRouter, netCollateral);

        // Open position on Moonlander
        uint256 leveragedAmount = netCollateral * leverage;
        uint256 direction = isLong ? 2 : 0; // Moonlander: 2=long, 0=short

        // Call Moonlander's openMarketTradeWithPythAndExtraFee
        bytes[] memory emptyPythData = new bytes[](0);
        uint256 tradeIndex = IMoonlanderRouter(moonlanderRouter)
            .openMarketTradeWithPythAndExtraFee{value: 0.06 ether}(
                address(0),         // No referrer
                pairIndex,
                address(collateralToken),
                netCollateral,
                0,                  // openPrice (use market)
                leveragedAmount,
                0,                  // tp (set later)
                0,                  // sl (set later)
                direction,
                0,                  // fee
                emptyPythData
            );

        // Store ZK commitment
        IZKHedgeCommitment(zkCommitment).storeCommitment(
            commitmentHash,
            nullifier,
            merkleRoot
        );

        // Record hedge
        nullifierUsed[nullifier] = true;
        hedges[hedgeId] = HedgePosition({
            hedgeId: hedgeId,
            trader: msg.sender,
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
            status: HedgeStatus.ACTIVE
        });

        userHedges[msg.sender].push(hedgeId);
        totalHedgesOpened++;
        totalCollateralLocked += netCollateral;

        emit HedgeOpened(
            hedgeId,
            msg.sender,
            pairIndex,
            isLong,
            netCollateral,
            leverage,
            commitmentHash
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE: CLOSE HEDGE
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Close a hedge position and settle PnL on-chain
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
        int256 pnl;
        if (balanceAfter >= balanceBefore) {
            pnl = int256(balanceAfter - balanceBefore) - int256(hedge.collateralAmount);
        } else {
            pnl = -int256(hedge.collateralAmount);
        }

        // Update hedge state
        hedge.status = HedgeStatus.CLOSED;
        hedge.closeTimestamp = block.timestamp;
        hedge.realizedPnl = pnl;

        totalHedgesClosed++;
        totalCollateralLocked -= hedge.collateralAmount;
        totalPnlRealized += pnl;

        // Return collateral + PnL to trader
        uint256 returnAmount;
        if (pnl >= 0) {
            returnAmount = hedge.collateralAmount + uint256(pnl);
        } else if (uint256(-pnl) < hedge.collateralAmount) {
            returnAmount = hedge.collateralAmount - uint256(-pnl);
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
            pnl,
            block.timestamp - hedge.openTimestamp
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE: ADD MARGIN
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Add collateral to an existing hedge to reduce liquidation risk
     * @param hedgeId The hedge to add margin to
     * @param amount Additional collateral amount
     */
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
    // AGENT: BATCH OPERATIONS
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Agent opens hedge on behalf of a user (gasless via relayer)
     * @dev Requires AGENT_ROLE - used by SettlementAgent for auto-hedging
     */
    function agentOpenHedge(
        address trader,
        uint256 pairIndex,
        uint256 collateralAmount,
        uint256 leverage,
        bool isLong,
        bytes32 commitmentHash,
        bytes32 nullifier,
        bytes32 merkleRoot
    ) external payable onlyRole(AGENT_ROLE) nonReentrant whenNotPaused returns (bytes32 hedgeId) {
        require(msg.value >= 0.06 ether, "Insufficient oracle fee");
        require(collateralAmount >= minCollateral, "Below min collateral");
        require(leverage >= 2 && leverage <= maxLeverage, "Invalid leverage");
        require(!nullifierUsed[nullifier], "Nullifier already used");

        hedgeId = keccak256(abi.encodePacked(
            trader,
            pairIndex,
            collateralAmount,
            block.timestamp,
            totalHedgesOpened
        ));

        uint256 fee = (collateralAmount * feeRateBps) / 10000;
        uint256 netCollateral = collateralAmount - fee;

        // Collateral must already be in this contract (pre-funded by vault)
        require(
            collateralToken.balanceOf(address(this)) >= netCollateral + accumulatedFees,
            "Insufficient contract balance"
        );

        accumulatedFees += fee;
        collateralToken.approve(moonlanderRouter, netCollateral);

        uint256 leveragedAmount = netCollateral * leverage;
        uint256 direction = isLong ? 2 : 0;

        bytes[] memory emptyPythData = new bytes[](0);
        uint256 tradeIndex = IMoonlanderRouter(moonlanderRouter)
            .openMarketTradeWithPythAndExtraFee{value: 0.06 ether}(
                address(0), pairIndex, address(collateralToken),
                netCollateral, 0, leveragedAmount, 0, 0, direction, 0, emptyPythData
            );

        IZKHedgeCommitment(zkCommitment).storeCommitment(commitmentHash, nullifier, merkleRoot);

        nullifierUsed[nullifier] = true;
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
            status: HedgeStatus.ACTIVE
        });

        userHedges[trader].push(hedgeId);
        totalHedgesOpened++;
        totalCollateralLocked += netCollateral;

        emit HedgeOpened(hedgeId, trader, pairIndex, isLong, netCollateral, leverage, commitmentHash);
    }

    /**
     * @notice Emergency close by admin/agent
     */
    function emergencyCloseHedge(
        bytes32 hedgeId,
        string calldata reason
    ) external onlyRole(AGENT_ROLE) nonReentrant {
        HedgePosition storage hedge = hedges[hedgeId];
        require(hedge.status == HedgeStatus.ACTIVE, "Not active");

        uint256 balanceBefore = collateralToken.balanceOf(address(this));

        IMoonlanderRouter(moonlanderRouter).closeTrade(hedge.pairIndex, hedge.tradeIndex);

        uint256 balanceAfter = collateralToken.balanceOf(address(this));
        int256 pnl = int256(balanceAfter) - int256(balanceBefore) - int256(hedge.collateralAmount);

        hedge.status = HedgeStatus.CLOSED;
        hedge.closeTimestamp = block.timestamp;
        hedge.realizedPnl = pnl;

        totalHedgesClosed++;
        totalCollateralLocked -= hedge.collateralAmount;
        totalPnlRealized += pnl;

        uint256 returnAmount = balanceAfter > balanceBefore
            ? balanceAfter - balanceBefore
            : 0;

        if (returnAmount > 0) {
            collateralToken.safeTransfer(hedge.trader, returnAmount);
        }

        emit EmergencyClose(hedgeId, msg.sender, reason);
    }

    // ═══════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Get all hedge IDs for a user
     */
    function getUserHedges(address trader) external view returns (bytes32[] memory) {
        return userHedges[trader];
    }

    /**
     * @notice Get active hedge count for a user
     */
    function getActiveHedgeCount(address trader) external view returns (uint256 count) {
        bytes32[] storage ids = userHedges[trader];
        for (uint256 i = 0; i < ids.length; i++) {
            if (hedges[ids[i]].status == HedgeStatus.ACTIVE) {
                count++;
            }
        }
    }

    /**
     * @notice Get protocol statistics
     */
    function getProtocolStats() external view returns (
        uint256 _totalOpened,
        uint256 _totalClosed,
        uint256 _collateralLocked,
        int256 _totalPnl,
        uint256 _fees
    ) {
        return (totalHedgesOpened, totalHedgesClosed, totalCollateralLocked, totalPnlRealized, accumulatedFees);
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

    function withdrawFees(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 fees = accumulatedFees;
        accumulatedFees = 0;
        collateralToken.safeTransfer(to, fees);
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
