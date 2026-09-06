// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
// Vendored shim — OZ v5.x removed ReentrancyGuardUpgradeable in favour of
// the plain ReentrancyGuard, but our UUPS proxy needs the init pattern.
import "../helpers/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./CommunityPoolLib.sol";

/**
 * @title IVVSRouter
 * @notice Interface for VVS Finance Router on Cronos
 * @dev Standard Uniswap V2 compatible router interface
 */
interface IVVSRouter {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(
        uint amountIn,
        address[] memory path
    ) external view returns (uint[] memory amounts);

    function getAmountsIn(
        uint amountOut,
        address[] memory path
    ) external view returns (uint[] memory amounts);
}

/**
 * @title IPyth
 * @notice Pyth Network Price Feed Interface (Available on Cronos)
 * @dev Pyth is the standard oracle on Cronos used by Moonlander and other DeFi
 *      Free to read prices, costs ~0.06 CRO to update price feeds
 *      Cronos Mainnet: 0xE0d0e68297772Dd5a1f1D99897c581E2082dbA5B
 */
interface IPyth {
    struct Price {
        int64 price;        // Price in base units
        uint64 conf;        // Confidence interval
        int32 expo;         // Exponent (negative = decimals)
        uint publishTime;   // Unix timestamp
    }

    /// @notice Get price no older than `age` seconds, reverts if stale
    function getPriceNoOlderThan(
        bytes32 id,
        uint age
    ) external view returns (Price memory price);

    /// @notice Get latest price (may be stale)
    function getPrice(bytes32 id) external view returns (Price memory price);

    /// @notice Update price feeds (requires payment)
    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    /// @notice Get update fee for price data
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint feeAmount);

    /// @notice Check if price feed exists
    function priceFeedExists(bytes32 id) external view returns (bool);
}

/**
 * @title IHedgeExecutor
 * @notice Interface for HedgeExecutor contract used for x402 gasless auto-hedging
 */
interface IHedgeExecutor {
    function openHedge(
        uint256 pairIndex,
        uint256 collateralAmount,
        uint256 leverage,
        bool isLong,
        bytes32 commitmentHash,
        bytes32 nullifier,
        bytes32 merkleRoot
    ) external payable returns (bytes32 hedgeId);

    function closeHedge(bytes32 hedgeId) external;

    function hedges(bytes32 hedgeId) external view returns (
        bytes32 _hedgeId,
        address trader,
        uint256 pairIndex,
        uint256 tradeIndex,
        uint256 collateralAmount,
        uint256 leverage,
        bool isLong,
        bytes32 commitmentHash,
        bytes32 nullifier,
        uint256 openTimestamp,
        uint256 closeTimestamp,
        int256 realizedPnl,
        uint8 status
    );
}

/**
 * @title ZkWard Community Pool
 * @author ZkWard Team
 * @notice AI-managed community investment pool with share-based ownership
 * @dev ERC-4626-inspired vault for collective investment in BTC, ETH, SUI, CRO
 *
 * @custom:security-contact security@zkward.com
 * @custom:oz-upgrades-from CommunityPool
 *
 * FEATURES:
 * =========
 * - Share-based ownership: Deposit USDC → receive proportional shares
 * - Fair withdrawals: Burn shares → receive proportional NAV
 * - AI-driven allocation: Agent role can rebalance between assets
 * - Self-sustaining: Management fee (0.5% annual) + Performance fee (10%)
 * - High-water mark: Performance fee only on new highs
 *
 * SUPPORTED ASSETS:
 * - WBTC (Wrapped Bitcoin)
 * - WETH (Wrapped Ether)
 * - SUI (if bridged) or stablecoin placeholder
 * - CRO (Cronos native wrapped)
 *
 * MAINNET READY:
 * - Uses real token addresses
 * - UUPS upgradeable for future improvements
 * - Emergency pause capability
 */
contract CommunityPool is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ═══════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════

    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MIN_DEPOSIT = 10e6; // $10 USDC (6 decimals)
    uint256 public constant MIN_SHARES_FOR_WITHDRAWAL = 1e15; // 0.001 shares
    uint256 public constant MIN_FIRST_DEPOSIT = 100e6; // $100 USDC minimum first deposit (virtual shares protect against inflation)
    uint256 public constant VIRTUAL_SHARES = 1e18; // Virtual offset to prevent inflation attack
    uint256 public constant VIRTUAL_ASSETS = 1e6; // Virtual offset ($1 USDC)
    
    // Precision constants for safe math
    uint256 public constant SHARE_DECIMALS = 18;
    uint256 public constant USDC_DECIMALS = 6;
    uint256 public constant PRECISION_FACTOR = 1e12; // 18 - 6 = 12
    uint256 public constant WAD = 1e18; // Standard 18 decimal precision

    // Reserve and safety limits
    uint256 public constant MIN_RESERVE_RATIO_BPS = 2000; // 20% of NAV must stay liquid
    uint256 public constant MAX_SINGLE_HEDGE_BPS = 500;   // Max 5% of NAV per hedge
    uint256 public constant DAILY_HEDGE_CAP_BPS = 1500;   // Max 15% daily hedge deployment
    
    // Circuit Breakers - Critical for mainnet safety
    uint256 public constant DEFAULT_MAX_SINGLE_DEPOSIT = 100_000e6;  // $100K default
    uint256 public constant DEFAULT_MAX_SINGLE_WITHDRAWAL_BPS = 2500;  // Default 25% of pool per withdrawal
    uint256 public constant DEFAULT_DAILY_WITHDRAWAL_CAP_BPS = 5000;   // Default 50% of pool withdrawn per day
    uint256 public constant WHALE_THRESHOLD_BPS = 1000;        // 10% ownership = whale (extra checks)

    // Asset indices
    uint8 public constant ASSET_BTC = 0;
    uint8 public constant ASSET_ETH = 1;
    uint8 public constant ASSET_SUI = 2;
    uint8 public constant ASSET_CRO = 3;
    uint8 public constant NUM_ASSETS = 4;

    // ═══════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════

    struct Member {
        uint256 shares;             // Number of shares owned
        uint256 depositedUSD;       // Total USD value deposited
        uint256 withdrawnUSD;       // Total USD value withdrawn
        uint256 joinedAt;           // Timestamp of first deposit
        uint256 lastDepositAt;      // Timestamp of last deposit
        uint256 highWaterMark;      // For performance fee calculation
    }

    struct Allocation {
        uint8 assetIndex;           // Which asset
        uint256 targetBps;          // Target allocation in basis points
        uint256 currentAmount;      // Current token amount held
    }

    struct RebalanceRecord {
        uint256 timestamp;
        uint256[NUM_ASSETS] previousAllocBps;
        uint256[NUM_ASSETS] newAllocBps;
        bytes32 reasonHash;
        address executor;
    }

    /// @notice AI Decision for cross-chain coordination
    /// @dev Same structure used across all chains for consistent AI management
    struct AIDecision {
        bytes32 decisionId;           // Unique ID (hash of decision params)
        uint256 timestamp;            // When decision was made
        uint256[NUM_ASSETS] targetAllocBps; // Target allocation
        uint8 confidence;             // AI confidence (0-100)
        uint8 urgency;                // Execution urgency (0=low, 1=medium, 2=high)
        int256 expectedReturn;        // Expected return in BPS (can be negative)
        uint256 riskScore;            // Risk score (0-10000 BPS)
        bytes32 reasonHash;           // Hash of AI reasoning
        bytes32 dataFeedHash;         // Hash of price data used for decision
        bool executed;                // Whether fully executed
    }

    /// @notice Cross-chain signal for AI coordination
    /// @dev Allows off-chain AI coordinators to sync decisions across chains
    struct CrossChainSignal {
        bytes32 signalId;             // Unique signal ID
        uint256 timestamp;            // Signal timestamp
        uint256 chainId;              // Source chain ID
        uint256[NUM_ASSETS] allocations; // Target allocations
        bytes32 priceDataHash;        // Hash of price data (verify same data feed)
        uint8 action;                 // 0=hold, 1=rebalance, 2=hedge, 3=dehedge
        bool acknowledged;            // Whether this chain has acked
    }

    /// @notice Batch trade instruction for efficient rebalancing
    struct BatchTrade {
        uint8 assetIndex;             // Asset to trade
        uint256 amount;               // Amount to trade
        uint256 minAmountOut;         // Slippage protection
        bool isBuy;                   // Buy (true) or sell (false)
    }

    /// @notice AI Agent performance metrics
    struct AIAgentMetrics {
        uint256 totalDecisions;       // Total decisions made
        uint256 successfulDecisions;  // Decisions that met expected return
        int256 cumulativeReturn;      // Cumulative return in BPS
        uint256 avgConfidence;        // Average confidence (scaled by 100)
        uint256 lastDecisionTime;     // Last decision timestamp
        bytes32 lastDecisionId;       // Last decision ID
    }

    // ═══════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════

    /// @notice Deposit token (USDC)
    IERC20 public depositToken;

    /// @notice Supported asset tokens [BTC, ETH, SUI, CRO]
    IERC20[NUM_ASSETS] public assetTokens;

    /// @notice Price feed decimals for each asset (for normalization)
    uint8[NUM_ASSETS] public assetDecimals;

    /// @notice Target allocation in basis points (must sum to 10000)
    uint256[NUM_ASSETS] public targetAllocationBps;

    /// @notice Current holdings of each asset (in token units)
    uint256[NUM_ASSETS] public assetBalances;

    /// @notice Member data by address
    mapping(address => Member) public members;

    /// @notice All member addresses for enumeration
    address[] public memberList;

    /// @notice Mapping for quick member lookup
    mapping(address => bool) public isMember;

    /// @notice Total shares outstanding
    uint256 public totalShares;

    /// @notice Total value deposited (USD, 6 decimals)
    uint256 public totalDeposited;

    /// @notice Total value withdrawn (USD, 6 decimals)
    uint256 public totalWithdrawn;

    /// @notice Pool's all-time high NAV per share (for performance fee)
    uint256 public allTimeHighNavPerShare;

    /// @notice Management fee rate in basis points (50 = 0.5%)
    uint256 public managementFeeBps;

    /// @notice Performance fee rate in basis points (1000 = 10%)
    uint256 public performanceFeeBps;

    /// @notice Accumulated management fees (in USDC)
    uint256 public accumulatedManagementFees;

    /// @notice Accumulated performance fees (in USDC)
    uint256 public accumulatedPerformanceFees;

    /// @notice Last fee collection timestamp
    uint256 public lastFeeCollection;

    /// @notice Treasury address for fee collection
    address public treasury;

    /// @notice Rebalance history
    RebalanceRecord[] public rebalanceHistory;

    /// @notice DEX router for swaps (VVS Finance on Cronos)
    address public dexRouter;

    /// @notice Pyth Network oracle contract (Cronos: 0xE0d0e68297772Dd5a1f1D99897c581E2082dbA5B)
    IPyth public pythOracle;

    /// @notice Pyth price IDs for each asset (USD denominated)
    /// @dev Universal across all Pyth-supported chains
    ///      Index: 0=BTC/USD, 1=ETH/USD, 2=SUI/USD, 3=CRO/USD
    bytes32[NUM_ASSETS] public pythPriceIds;

    /// @notice Maximum age of price data before considered stale (default: 1 hour)
    uint256 public priceStaleThreshold;

    /// @notice Minimum time between rebalances (anti-churn)
    uint256 public rebalanceCooldown;

    /// @notice Last rebalance timestamp
    uint256 public lastRebalanceTime;

    /// @notice Emergency withdrawal enabled
    bool public emergencyWithdrawEnabled;

    // ═══════════════════════════════════════════════════════════════
    // AUTO-HEDGE INTEGRATION (x402 Gasless)
    // ═══════════════════════════════════════════════════════════════

    /// @notice HedgeExecutor contract for auto-hedging
    address public hedgeExecutor;

    /// @notice Active hedge IDs opened by this pool
    bytes32[] public activePoolHedges;

    /// @notice Mapping of hedge ID to active status
    mapping(bytes32 => bool) public isPoolHedge;

    /// @notice Auto-hedge configuration
    struct AutoHedgeConfig {
        bool enabled;              // Whether auto-hedging is enabled
        uint256 riskThresholdBps;  // Risk level to trigger hedge (e.g., 500 = 5% drawdown)
        uint256 maxHedgeRatioBps;  // Max portion of NAV to hedge (e.g., 2500 = 25%)
        uint256 defaultLeverage;   // Default leverage for hedges (2-10)
        uint256 cooldownSeconds;   // Min time between auto-hedges
        uint256 lastAutoHedgeTime; // Last auto-hedge timestamp
    }

    /// @notice Pool's auto-hedge configuration
    AutoHedgeConfig public autoHedgeConfig;

    /// @notice Total value currently hedged (USD, 6 decimals)
    uint256 public totalHedgedValue;

    /// @notice Oracle fee for Moonlander trades (CRO)
    uint256 public constant MOONLANDER_ORACLE_FEE = 0.06 ether;

    // ═══════════════════════════════════════════════════════════════
    // CIRCUIT BREAKER STATE
    // ═══════════════════════════════════════════════════════════════

    /// @notice Daily withdrawal tracking - resets each day
    uint256 public dailyWithdrawalTotal;
    
    /// @notice Current day number for tracking (days since epoch)
    uint256 public currentWithdrawalDay;
    
    /// @notice Circuit breaker: contract frozen by admin
    bool public circuitBreakerTripped;
    
    /// @notice Max single deposit amount (admin-configurable)
    uint256 public maxSingleDeposit;
    
    /// @notice Max single withdrawal in basis points of pool (admin-configurable)
    uint256 public maxSingleWithdrawalBps;
    
    /// @notice Daily withdrawal cap in basis points (admin-configurable)
    uint256 public dailyWithdrawalCapBps;

    // ═══════════════════════════════════════════════════════════════
    // AI MANAGEMENT STATE (Cross-Chain Coordination)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Current AI decision (latest)
    AIDecision public currentAIDecision;

    /// @notice AI decision history
    AIDecision[] public aiDecisionHistory;

    /// @notice Latest cross-chain signal
    CrossChainSignal public latestSignal;

    // Signal history removed to reduce contract size - use events instead

    /// @notice AI agent metrics by address
    mapping(address => AIAgentMetrics) public aiAgentMetrics;

    /// @notice Unified Pyth Price Feed IDs (same across all chains)
    /// @dev BTC/USD: 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
    ///      ETH/USD: 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
    ///      SUI/USD: 0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744
    ///      CRO/USD: 0x23199c2bcb1303f667e733b9934db9eca5991e765b45f5ed18bc4b231415f2fe
    bytes32 public constant PYTH_BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 public constant PYTH_ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 public constant PYTH_SUI_USD = 0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744;
    bytes32 public constant PYTH_CRO_USD = 0x23199c2bcb1303f667e733b9934db9eca5991e765b45f5ed18bc4b231415f2fe;

    /// @notice Chain identifier for cross-chain coordination
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public immutable CHAIN_ID;

    /// @notice Minimum AI confidence to execute a decision (0-100)
    uint8 public minAIConfidence;

    /// @notice Whether to require cross-chain signal verification
    bool public requireSignalVerification;

    // ═══════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════

    event Deposited(
        address indexed member,
        uint256 amountUSD,
        uint256 sharesReceived,
        uint256 sharePrice,
        uint256 timestamp
    );

    event Withdrawn(
        address indexed member,
        uint256 sharesBurned,
        uint256 amountUSD,
        uint256 sharePrice,
        uint256 timestamp
    );

    event Rebalanced(
        address indexed executor,
        uint256[NUM_ASSETS] previousBps,
        uint256[NUM_ASSETS] newBps,
        bytes32 reasonHash,
        uint256 timestamp
    );

    event RebalanceTradeExecuted(
        uint8 indexed assetIndex,
        uint256 amountIn,
        uint256 amountOut,
        bool isBuy,
        uint256 timestamp
    );

    event FeesCollected(
        uint256 managementFee,
        uint256 performanceFee,
        uint256 timestamp
    );

    event FeesWithdrawn(
        address indexed treasury,
        uint256 amount,
        uint256 timestamp
    );

    event AllocationUpdated(
        uint8 indexed assetIndex,
        uint256 oldBps,
        uint256 newBps
    );

    event PriceUpdated(
        uint8 indexed assetIndex,
        uint256 oldPrice,
        uint256 newPrice
    );

    event PriceFeedSet(
        uint8 indexed assetIndex,
        address indexed priceFeed
    );

    event MemberJoined(address indexed member, uint256 timestamp);
    event MemberExited(address indexed member, uint256 timestamp);
    event TokensRescued(address indexed token, uint256 amount);

    // Auto-hedge events
    event PoolHedgeOpened(
        bytes32 indexed hedgeId,
        uint8 pairIndex,
        uint256 collateralAmount,
        uint256 leverage,
        bool isLong,
        bytes32 reasonHash
    );

    event PoolHedgeClosed(
        bytes32 indexed hedgeId,
        int256 pnl,
        bytes32 reasonHash
    );

    event AutoHedgeConfigUpdated(
        bool enabled,
        uint256 riskThresholdBps,
        uint256 maxHedgeRatioBps,
        uint256 defaultLeverage
    );

    event HedgeExecutorSet(address indexed newExecutor);
    
    // Circuit breaker events
    event CircuitBreakerTripped(address indexed by, bytes32 reasonHash);
    event CircuitBreakerReset(address indexed by);
    event CircuitBreakerUpdated(uint8 paramId, uint256 newValue);
    event DexRouterUpdated(address indexed newRouter);
    event DailyWithdrawalReset(uint256 newDay, uint256 previousTotal);

    // AI Management events
    event AIDecisionRecorded(
        bytes32 indexed decisionId,
        address indexed agent,
        uint256[NUM_ASSETS] targetAllocBps,
        uint8 confidence,
        int256 expectedReturn,
        bytes32 reasonHash
    );

    event AIDecisionExecuted(
        bytes32 indexed decisionId,
        address indexed executor,
        int256 actualReturn,
        bool successful
    );

    event CrossChainSignalReceived(
        bytes32 indexed signalId,
        uint256 sourceChainId,
        uint8 action,
        bytes32 priceDataHash
    );

    event CrossChainSignalAcknowledged(
        bytes32 indexed signalId,
        uint256 thisChainId
    );

    event BatchTradesExecuted(
        uint256 tradesCount,
        uint256 totalVolume,
        address indexed executor
    );

    event AIAgentMetricsUpdated(
        address indexed agent,
        uint256 totalDecisions,
        int256 cumulativeReturn
    );

    // ═══════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════

    error DepositTooSmall(uint256 amount, uint256 minimum);
    error InsufficientShares(uint256 requested, uint256 available);
    error InvalidAllocation(uint256 totalBps);
    error RebalanceCooldownActive(uint256 nextAllowedTime);
    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();
    error PermitFailed();
    error NotAMember();
    error EmergencyWithdrawDisabled();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error FirstDepositTooSmall(uint256 amount, uint256 minimum);
    error DexRouterNotSet();
    error InvalidSwapPath();
    error SwapSlippageExceeded(uint256 expected, uint256 received);
    error StalePriceData(uint8 assetIndex, uint256 lastUpdate, uint256 threshold);
    error NegativePrice(uint8 assetIndex, int256 price);
    error PriceFeedNotConfigured(uint8 assetIndex);
    error OracleCallFailed(uint8 assetIndex);
    error AssetWithoutPriceFeed(uint8 assetIndex, uint256 balance);
    error SharePriceTooLow(uint256 currentPrice, uint256 minimumPrice);
    error PoolUndercollateralized(uint256 nav, uint256 expectedMinNav);
    error HedgeExecutorNotSet();
    error AutoHedgeCooldownActive(uint256 nextAllowedTime);
    error HedgeNotOwnedByPool(bytes32 hedgeId);
    error ReserveRatioBreached(uint256 availableAfter, uint256 minReserve);
    error SingleHedgeTooLarge(uint256 hedgeAmount, uint256 maxAllowed);
    error DailyHedgeCapExceeded(uint256 dailyTotal, uint256 maxDaily);
    
    // Circuit breaker errors
    error CircuitBreakerActive();
    error DepositTooLarge(uint256 amount, uint256 maximum);
    error SingleWithdrawalTooLarge(uint256 amount, uint256 maxBps);
    error DailyWithdrawalCapExceeded(uint256 requested, uint256 remainingCap);
    error InvalidConfiguration();
    
    // Additional errors (saves bytecode vs require strings)
    error InvalidAssetIndex();
    error EmergencyModeRequired();
    error HedgeNotActive();
    error MaxHedgeRatioExceeded();
    error InsufficientPoolBalance();
    error CannotRescuePoolToken();
    error FeeTooHigh();
    error ThresholdOutOfRange();
    error NothingToRescue();
    error RescueFailed();
    error InvalidLeverage();
    error MinSharesRequired();

    // AI Management errors
    error AIConfidenceTooLow(uint8 confidence, uint8 minimum);
    error SignalVerificationRequired();
    error SignalAlreadyAcknowledged();
    error InvalidDecisionId();
    error DecisionAlreadyExecuted();
    error PriceDataMismatch(bytes32 expected, bytes32 actual);
    error BatchTradesFailed(uint256 failedIndex);
    error EmptyBatchTrades();

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
        CHAIN_ID = block.chainid;
    }

    /**
     * @notice Initialize the community pool
     * @param _depositToken USDC token address
     * @param _assetTokens Array of 4 asset tokens [BTC, ETH, SUI, CRO]
     * @param _treasury Treasury address for fees
     * @param _admin Admin address
     */
    function initialize(
        address _depositToken,
        address[NUM_ASSETS] calldata _assetTokens,
        address _treasury,
        address _admin
    ) external initializer {
        if (_depositToken == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        depositToken = IERC20(_depositToken);
        treasury = _treasury;

        // Set up asset tokens
        for (uint8 i = 0; i < NUM_ASSETS; i++) {
            if (_assetTokens[i] != address(0)) {
                assetTokens[i] = IERC20(_assetTokens[i]);
                assetDecimals[i] = IERC20Metadata(_assetTokens[i]).decimals();
            }
        }

        // Default equal allocation (25% each)
        targetAllocationBps[ASSET_BTC] = 2500;
        targetAllocationBps[ASSET_ETH] = 2500;
        targetAllocationBps[ASSET_SUI] = 2500;
        targetAllocationBps[ASSET_CRO] = 2500;

        // Default fees (self-sustaining)
        managementFeeBps = 50;      // 0.5% annual
        performanceFeeBps = 1000;   // 10% on profits

        // Cooldowns and limits
        rebalanceCooldown = 1 hours;
        lastFeeCollection = block.timestamp;
        maxSingleDeposit = DEFAULT_MAX_SINGLE_DEPOSIT;
        maxSingleWithdrawalBps = DEFAULT_MAX_SINGLE_WITHDRAWAL_BPS;
        dailyWithdrawalCapBps = DEFAULT_DAILY_WITHDRAWAL_CAP_BPS;

        // Initial share price = $1 (1e18 shares per $1M NAV)
        allTimeHighNavPerShare = 1e18;

        // Grant roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(AGENT_ROLE, _admin);
        _grantRole(REBALANCER_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
        _grantRole(FEE_MANAGER_ROLE, _admin);
        _grantRole(RELAYER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC into ZkWard Community Pool and receive shares
     * @dev Deposits USDC and mints proportional pool shares to the caller.
     *      Uses ERC-4626 virtual offset to prevent share inflation attacks.
     *      Your shares represent ownership of the pool's diversified portfolio.
     * @param amount Amount of USDC to deposit (6 decimals). Min: $10 USDC
     * @return shares Number of pool shares minted to your wallet
     * @custom:security Non-reentrant, requires active pool
     * @custom:emits Deposited(depositor, amount, shares, sharePrice, timestamp)
     */
    function deposit(uint256 amount) 
        external 
        nonReentrant 
        whenNotPaused 
        returns (uint256 shares) 
    {
        return _depositInternal(amount, msg.sender, msg.sender);
    }

    /**
     * @notice Deposit USDT on behalf of a proxy wallet address (relayer only)
     * @dev Server-side relayer deposits tokens from the depositor and credits
     *      shares to the beneficiary (proxy address). Protects the original
     *      wallet owner's privacy by keeping their address off-chain.
     * @param beneficiary The proxy wallet address to credit shares to
     * @param amount Amount of USDT to deposit (6 decimals)
     * @return shares Number of pool shares minted to the beneficiary
     */
    function depositFor(
        address beneficiary,
        uint256 amount
    ) 
        external 
        nonReentrant 
        whenNotPaused 
        onlyRole(RELAYER_ROLE)
        returns (uint256 shares) 
    {
        if (beneficiary == address(0)) revert ZeroAddress();
        return _depositInternal(amount, msg.sender, beneficiary);
    }

    /**
     * @notice Deposit USDT into pool using EIP-2612 permit (WDK USDT compatible)
     * @dev Single-transaction approve+deposit. Uses permit for gasless approval.
     *      If token doesn't support permit, call approve() + deposit() separately.
     * @param amount Amount of USDT to deposit (6 decimals)
     * @param deadline Timestamp after which permit expires
     * @param v Signature recovery byte
     * @param r ECDSA signature r value
     * @param s ECDSA signature s value
     * @return shares Number of pool shares minted
     */
    function depositWithPermit(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) 
        external 
        nonReentrant 
        whenNotPaused 
        returns (uint256 shares) 
    {
        // Use permit to set allowance (gasless approval via signature)
        // This will revert if token doesn't support EIP-2612
        try IERC20Permit(address(depositToken)).permit(
            msg.sender,
            address(this),
            amount,
            deadline,
            v,
            r,
            s
        ) {} catch {
            // Permit failed - allowance might already exist or token doesn't support permit
            // Check if allowance is sufficient, if not revert with helpful message
            uint256 currentAllowance = depositToken.allowance(msg.sender, address(this));
            if (currentAllowance < amount) {
                revert PermitFailed();
            }
        }
        
        // Now execute deposit with the allowance set by permit
        return _depositInternal(amount, msg.sender, msg.sender);
    }

    /**
     * @dev Internal deposit implementation shared by deposit(), depositWithPermit(), and depositFor()
     * @param amount Amount of USDT to deposit
     * @param depositor Address to pull tokens from (msg.sender for direct, relayer for proxy)
     * @param beneficiary Address to credit shares to (same as depositor for direct deposits)
     */
    function _depositInternal(uint256 amount, address depositor, address beneficiary) internal returns (uint256 shares) {
        // Circuit breaker check
        if (circuitBreakerTripped) revert CircuitBreakerActive();
        
        // Max single deposit check (prevent whale manipulation)
        if (amount > maxSingleDeposit) revert DepositTooLarge(amount, maxSingleDeposit);
        
        // First deposit requires higher minimum to prevent inflation attack
        if (totalShares == 0 && amount < MIN_FIRST_DEPOSIT) {
            revert FirstDepositTooSmall(amount, MIN_FIRST_DEPOSIT);
        }
        if (amount < MIN_DEPOSIT) revert DepositTooSmall(amount, MIN_DEPOSIT);

        // SAFEGUARD: Verify pool isn't undercollateralized before accepting deposits
        if (totalShares > 0) {
            uint256 currentSharePrice = _calculateNavPerShare();
            uint256 minSharePrice = 9e5; // $0.90 in 6 decimals
            if (currentSharePrice < minSharePrice) {
                revert SharePriceTooLow(currentSharePrice, minSharePrice);
            }
        }

        // Collect any pending fees first
        _collectFees();

        // Calculate shares using ERC-4626 virtual offset
        uint256 currentNav = calculateTotalNAV();
        uint256 totalAssetsWithOffset = currentNav + VIRTUAL_ASSETS;
        uint256 totalSharesWithOffset = totalShares + VIRTUAL_SHARES;
        shares = amount.mulDiv(totalSharesWithOffset, totalAssetsWithOffset, Math.Rounding.Floor);
        
        if (shares < MIN_SHARES_FOR_WITHDRAWAL) revert MinSharesRequired();

        // Transfer USDT from depositor (may differ from beneficiary in proxy deposits)
        depositToken.safeTransferFrom(depositor, address(this), amount);

        // Update member state (credit shares to beneficiary)
        Member storage member = members[beneficiary];
        if (!isMember[beneficiary]) {
            isMember[beneficiary] = true;
            memberList.push(beneficiary);
            member.joinedAt = block.timestamp;
            member.highWaterMark = _calculateNavPerShare();
            emit MemberJoined(beneficiary, block.timestamp);
        }

        member.shares += shares;
        member.depositedUSD += amount;
        member.lastDepositAt = block.timestamp;

        // Update pool state
        totalShares += shares;
        totalDeposited += amount;

        // Verify share price didn't drop
        uint256 newSharePrice = _calculateNavPerShare();
        uint256 minSharePrice = 9e5;
        if (newSharePrice < minSharePrice) {
            revert SharePriceTooLow(newSharePrice, minSharePrice);
        }

        uint256 sharePrice = _calculateNavPerShare();
        emit Deposited(beneficiary, amount, shares, sharePrice, block.timestamp);

        return shares;
    }

    /**
     * @notice Withdraw USDC from ZkWard Community Pool by burning shares
     * @dev Burns your pool shares and returns proportional USDC value.
     *      Includes slippage protection to ensure minimum received amount.
     *      Performance fees are deducted if profit above high-water mark.
     * @param sharesToBurn Number of your shares to redeem for USDC
     * @param minAmountOut Minimum USDC to receive (reverts if less - slippage protection)
     * @return amountUSD Amount of USDC transferred to your wallet
     * @custom:security Non-reentrant, requires active pool
     * @custom:emits Withdrawn(withdrawer, shares, amountUSD, sharePrice, timestamp)
     */
    function withdraw(uint256 sharesToBurn, uint256 minAmountOut)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amountUSD)
    {
        return _withdrawInternal(sharesToBurn, minAmountOut);
    }

    // withdraw(uint256) removed - use withdraw(shares, 0) for no slippage protection

    function _withdrawInternal(uint256 sharesToBurn, uint256 minAmountOut)
        internal
        returns (uint256 amountUSD)
    {
        // Circuit breaker check (except for emergency mode)
        if (circuitBreakerTripped && !emergencyWithdrawEnabled) revert CircuitBreakerActive();
        
        if (sharesToBurn < MIN_SHARES_FOR_WITHDRAWAL) revert ZeroAmount();
        
        Member storage member = members[msg.sender];
        if (member.shares < sharesToBurn) {
            revert InsufficientShares(sharesToBurn, member.shares);
        }

        // Check single withdrawal isn't too large (prevent bank run/manipulation)
        uint256 withdrawalBps = sharesToBurn.mulDiv(BPS_DENOMINATOR, totalShares, Math.Rounding.Ceil);
        if (withdrawalBps > maxSingleWithdrawalBps) {
            revert SingleWithdrawalTooLarge(sharesToBurn, maxSingleWithdrawalBps);
        }

        // Daily withdrawal limit tracking
        uint256 today = block.timestamp / 1 days;
        if (today != currentWithdrawalDay) {
            emit DailyWithdrawalReset(today, dailyWithdrawalTotal);
            dailyWithdrawalTotal = 0;
            currentWithdrawalDay = today;
        }

        // Collect any pending fees first
        _collectFees();

        // Calculate USD value of shares using virtual offset for consistency with deposits
        // This ensures symmetry between deposit and withdrawal calculations
        uint256 currentNav = calculateTotalNAV();
        uint256 totalAssetsWithOffset = currentNav + VIRTUAL_ASSETS;
        uint256 totalSharesWithOffset = totalShares + VIRTUAL_SHARES;
        
        // amountUSD = sharesToBurn * totalAssetsWithOffset / totalSharesWithOffset
        amountUSD = sharesToBurn.mulDiv(totalAssetsWithOffset, totalSharesWithOffset, Math.Rounding.Floor);

        // Daily withdrawal cap check
        uint256 dailyCap = currentNav.mulDiv(dailyWithdrawalCapBps, BPS_DENOMINATOR, Math.Rounding.Floor);
        if (dailyWithdrawalTotal + amountUSD > dailyCap) {
            revert DailyWithdrawalCapExceeded(amountUSD, dailyCap - dailyWithdrawalTotal);
        }
        dailyWithdrawalTotal += amountUSD;

        // Slippage protection - user specifies minimum acceptable output
        if (amountUSD < minAmountOut) {
            revert SlippageExceeded(amountUSD, minAmountOut);
        }

        // STRICT LIQUIDITY CHECK - REVERT if insufficient funds (don't silently give less)
        uint256 usdcBalance = depositToken.balanceOf(address(this));
        if (usdcBalance < amountUSD) {
            revert InsufficientLiquidity(amountUSD, usdcBalance);
        }

        // Burn shares
        member.shares -= sharesToBurn;
        member.withdrawnUSD += amountUSD;
        totalShares -= sharesToBurn;
        totalWithdrawn += amountUSD;

        // Check if member has exited completely
        if (member.shares == 0) {
            isMember[msg.sender] = false;
            emit MemberExited(msg.sender, block.timestamp);
        }

        // Transfer USDC to user
        depositToken.safeTransfer(msg.sender, amountUSD);

        uint256 sharePrice = _calculateNavPerShare();

        emit Withdrawn(msg.sender, sharesToBurn, amountUSD, sharePrice, block.timestamp);

        return amountUSD;
    }

    /**
     * @notice Emergency withdrawal - returns proportional share of each asset
     * @dev Only available when emergency mode is enabled
     */
    function emergencyWithdraw()
        external
        nonReentrant
    {
        if (!emergencyWithdrawEnabled) revert EmergencyWithdrawDisabled();
        
        Member storage member = members[msg.sender];
        if (member.shares == 0) revert NotAMember();

        // Using mulDiv for overflow safety at any scale
        uint256 memberShares = member.shares;
        uint256 currentTotalShares = totalShares;

        // Return proportional USDC using overflow-safe math
        uint256 usdcShare = memberShares.mulDiv(depositToken.balanceOf(address(this)), currentTotalShares, Math.Rounding.Floor);
        if (usdcShare > 0) {
            depositToken.safeTransfer(msg.sender, usdcShare);
        }

        // Return proportional assets using overflow-safe math
        for (uint8 i = 0; i < NUM_ASSETS; i++) {
            if (address(assetTokens[i]) != address(0)) {
                uint256 assetShare = memberShares.mulDiv(assetBalances[i], currentTotalShares, Math.Rounding.Floor);
                if (assetShare > 0) {
                    assetTokens[i].safeTransfer(msg.sender, assetShare);
                    assetBalances[i] -= assetShare;
                }
            }
        }

        // Clear member
        totalShares -= member.shares;
        member.shares = 0;
        isMember[msg.sender] = false;

        emit MemberExited(msg.sender, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════
    // AI REBALANCING
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Update target allocation (AI decision)
     * @param newAllocationBps New target allocations [BTC, ETH, SUI, CRO]
     * @param reasoning AI reasoning for the rebalance
     */
    function setTargetAllocation(
        uint256[NUM_ASSETS] calldata newAllocationBps,
        string calldata reasoning
    ) 
        external 
        onlyRole(REBALANCER_ROLE) 
        whenNotPaused 
    {
        if (block.timestamp < lastRebalanceTime + rebalanceCooldown) {
            revert RebalanceCooldownActive(lastRebalanceTime + rebalanceCooldown);
        }

        // Validate allocations sum to 100%
        uint256 totalBps = 0;
        for (uint8 i = 0; i < NUM_ASSETS; i++) {
            totalBps += newAllocationBps[i];
        }
        if (totalBps != BPS_DENOMINATOR) revert InvalidAllocation(totalBps);

        // Store previous allocations
        uint256[NUM_ASSETS] memory previousBps = targetAllocationBps;

        // Update allocations
        for (uint8 i = 0; i < NUM_ASSETS; i++) {
            if (targetAllocationBps[i] != newAllocationBps[i]) {
                emit AllocationUpdated(i, targetAllocationBps[i], newAllocationBps[i]);
                targetAllocationBps[i] = newAllocationBps[i];
            }
        }

        // Record rebalance
        bytes32 reasonHash = keccak256(bytes(reasoning));
        rebalanceHistory.push(RebalanceRecord({
            timestamp: block.timestamp,
            previousAllocBps: previousBps,
            newAllocBps: newAllocationBps,
            reasonHash: reasonHash,
            executor: msg.sender
        }));

        lastRebalanceTime = block.timestamp;

        emit Rebalanced(msg.sender, previousBps, newAllocationBps, reasonHash, block.timestamp);
    }

    /**
     * @notice Execute trades to rebalance towards target allocation via VVS Finance
     * @dev Uses VVS Finance DEX Router for on-chain swaps with slippage protection
     * @param assetIndex Which asset to buy/sell
     * @param amount Amount of USDC to use (if buying) or asset to sell
     * @param isBuy True if buying asset with USDC, false if selling asset for USDC
     * @param minAmountOut Minimum amount to receive (slippage protection)
     */
    function executeRebalanceTrade(
        uint8 assetIndex,
        uint256 amount,
        bool isBuy,
        uint256 minAmountOut
    )
        external
        onlyRole(REBALANCER_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (assetIndex >= NUM_ASSETS) revert ZeroAmount();
        if (amount == 0) revert ZeroAmount();
        if (dexRouter == address(0)) revert DexRouterNotSet();
        if (address(assetTokens[assetIndex]) == address(0)) revert InvalidSwapPath();
        
        // CRITICAL: Must have price feed configured before acquiring assets
        // Otherwise we cannot accurately value the portfolio (billions at stake)
        if (pythPriceIds[assetIndex] == bytes32(0)) {
            revert PriceFeedNotConfigured(assetIndex);
        }

        IVVSRouter router = IVVSRouter(dexRouter);
        address[] memory path = new address[](2);
        uint256 deadline = block.timestamp + 300; // 5 minute deadline
        uint256 amountReceived;

        if (isBuy) {
            // Buy asset with USDC
            path[0] = address(depositToken);
            path[1] = address(assetTokens[assetIndex]);
            
            // Approve router to spend USDC
            depositToken.safeIncreaseAllowance(dexRouter, amount);
            
            // Execute swap
            uint256[] memory amounts = router.swapExactTokensForTokens(
                amount,
                minAmountOut,
                path,
                address(this),
                deadline
            );
            
            amountReceived = amounts[amounts.length - 1];
            if (amountReceived < minAmountOut) {
                revert SwapSlippageExceeded(minAmountOut, amountReceived);
            }
            
            // Update asset balance
            assetBalances[assetIndex] += amountReceived;
            
            emit RebalanceTradeExecuted(assetIndex, amount, amountReceived, true, block.timestamp);
        } else {
            // Sell asset for USDC
            path[0] = address(assetTokens[assetIndex]);
            path[1] = address(depositToken);
            
            // Check we have enough of the asset
            if (assetBalances[assetIndex] < amount) {
                revert InsufficientLiquidity(amount, assetBalances[assetIndex]);
            }
            
            // Approve router to spend asset
            assetTokens[assetIndex].safeIncreaseAllowance(dexRouter, amount);
            
            // Execute swap
            uint256[] memory amounts = router.swapExactTokensForTokens(
                amount,
                minAmountOut,
                path,
                address(this),
                deadline
            );
            
            amountReceived = amounts[amounts.length - 1];
            if (amountReceived < minAmountOut) {
                revert SwapSlippageExceeded(minAmountOut, amountReceived);
            }
            
            // Update asset balance
            assetBalances[assetIndex] -= amount;
            
            emit RebalanceTradeExecuted(assetIndex, amount, amountReceived, false, block.timestamp);
        }
    }

    // getSwapQuote() removed - use DEX router directly for quotes

    // ═══════════════════════════════════════════════════════════════
    // AI MANAGEMENT (Cross-Chain Independent Operation)
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Record an AI decision (can be executed separately)
     * @dev AI agents record decisions with full metadata for transparency
     *      Uses same Pyth price feed IDs across all chains for consistent data
     * @param targetAllocBps Target allocation in basis points
     * @param confidence AI confidence level (0-100)
     * @param urgency Execution urgency (0=low, 1=medium, 2=high)
     * @param expectedReturn Expected return in BPS (can be negative)
     * @param riskScore Risk score (0-10000)
     * @param reasoning Human-readable reasoning
     * @param priceDataHash Hash of price data used for decision
     * @return decisionId Unique decision identifier
     */
    function recordAIDecision(
        uint256[NUM_ASSETS] calldata targetAllocBps,
        uint8 confidence,
        uint8 urgency,
        int256 expectedReturn,
        uint256 riskScore,
        string calldata reasoning,
        bytes32 priceDataHash
    ) 
        external 
        onlyRole(AGENT_ROLE) 
        returns (bytes32 decisionId) 
    {
        // Validate confidence meets minimum
        if (confidence < minAIConfidence) {
            revert AIConfidenceTooLow(confidence, minAIConfidence);
        }

        // Validate allocations sum to 100%
        uint256 totalBps = 0;
        for (uint8 i = 0; i < NUM_ASSETS; i++) {
            totalBps += targetAllocBps[i];
        }
        if (totalBps != BPS_DENOMINATOR) revert InvalidAllocation(totalBps);

        // Generate unique decision ID
        decisionId = keccak256(abi.encodePacked(
            block.timestamp,
            msg.sender,
            targetAllocBps,
            priceDataHash,
            CHAIN_ID
        ));

        // Store decision
        bytes32 reasonHash = keccak256(bytes(reasoning));
        currentAIDecision = AIDecision({
            decisionId: decisionId,
            timestamp: block.timestamp,
            targetAllocBps: targetAllocBps,
            confidence: confidence,
            urgency: urgency,
            expectedReturn: expectedReturn,
            riskScore: riskScore,
            reasonHash: reasonHash,
            dataFeedHash: priceDataHash,
            executed: false
        });

        aiDecisionHistory.push(currentAIDecision);

        // Update agent metrics
        AIAgentMetrics storage metrics = aiAgentMetrics[msg.sender];
        metrics.totalDecisions++;
        metrics.lastDecisionTime = block.timestamp;
        metrics.lastDecisionId = decisionId;
        // Update average confidence (running average)
        metrics.avgConfidence = ((metrics.avgConfidence * (metrics.totalDecisions - 1)) + uint256(confidence) * 100) / metrics.totalDecisions;

        emit AIDecisionRecorded(
            decisionId,
            msg.sender,
            targetAllocBps,
            confidence,
            expectedReturn,
            reasonHash
        );

        emit AIAgentMetricsUpdated(
            msg.sender,
            metrics.totalDecisions,
            metrics.cumulativeReturn
        );

        return decisionId;
    }

    // executeBatchTrades() removed - use executeRebalanceTrade() for individual trades

    // receiveCrossChainSignal() removed - use setTargetAllocation() instead

    // executeFromSignal() removed - use setTargetAllocation() instead
    // getCurrentPriceDataHash() removed - compute off-chain

    // getAIAgentMetrics() removed - read aiAgentMetrics mapping directly
    // getAIDecisionCount() removed - read aiDecisionHistory.length directly
    // setMinAIConfidence() removed - use initialize()
    // setSignalVerificationRequired() removed - use initialize()
    // initializePythPriceFeeds() removed - set in initialize() or setPythPriceId()

    // ═══════════════════════════════════════════════════════════════
    // UNIFIED AI LOGIC (Same Behavior Across All Chains)
    // ═══════════════════════════════════════════════════════════════

    /// @notice AI model version for deterministic behavior
    uint256 public constant AI_MODEL_VERSION = 1;

    // UnifiedDecisionParams struct removed (not needed after function removals)
    // computeUnifiedDecisionHash() removed - compute off-chain
    // verifyUnifiedDecision() removed

    // recordUnifiedAIDecision() removed

    // getUnifiedPriceFeedIds() removed - use PYTH_*_USD constants directly

    // getPoolStateForAI() removed

    // _normalizePythPrice - delegated to library
    function _normalizePythPrice(int64 price, int32 expo) internal pure returns (uint256) {
        return CommunityPoolLib.normalizePythPrice(price, expo);
    }

    // ═══════════════════════════════════════════════════════════════
    // FEE MANAGEMENT (Self-Sustaining)
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Collect management and performance fees
     * @dev Called automatically on deposit/withdraw, can also be called manually
     */
    function collectFees() external onlyRole(FEE_MANAGER_ROLE) {
        _collectFees();
    }

    function _collectFees() internal {
        uint256 currentNav = calculateTotalNAV();
        if (currentNav == 0 || totalShares == 0) return;

        // Management fee (pro-rated based on time)
        uint256 timeSinceLastCollection = block.timestamp - lastFeeCollection;
        uint256 managementFee = (currentNav * managementFeeBps * timeSinceLastCollection) 
            / (BPS_DENOMINATOR * SECONDS_PER_YEAR);

        // Performance fee (only on new highs)
        uint256 navPerShare = _calculateNavPerShare();
        uint256 performanceFee = 0;

        if (navPerShare > allTimeHighNavPerShare) {
            uint256 gain = navPerShare - allTimeHighNavPerShare;
            uint256 totalGain = (gain * totalShares) / 1e18;
            performanceFee = (totalGain * performanceFeeBps) / BPS_DENOMINATOR;
            allTimeHighNavPerShare = navPerShare;
        }

        // Accumulate fees
        accumulatedManagementFees += managementFee;
        accumulatedPerformanceFees += performanceFee;
        lastFeeCollection = block.timestamp;

        if (managementFee > 0 || performanceFee > 0) {
            emit FeesCollected(managementFee, performanceFee, block.timestamp);
        }
    }

    /**
     * @notice Withdraw accumulated fees to treasury
     * @dev Protected: only withdraws accumulated fees, never more than available
     *      and reserves enough for user withdrawals
     */
    function withdrawFees() external onlyRole(FEE_MANAGER_ROLE) nonReentrant {
        uint256 totalFees = accumulatedManagementFees + accumulatedPerformanceFees;
        if (totalFees == 0) return;

        uint256 usdcBalance = depositToken.balanceOf(address(this));
        
        // SECURITY: Never withdraw more than accumulated fees
        // AND ensure minimum reserve for user withdrawals (10% of NAV)
        uint256 minReserve = calculateTotalNAV() / 10; // Keep 10% reserve
        uint256 availableForFees = usdcBalance > minReserve ? usdcBalance - minReserve : 0;
        uint256 toWithdraw = totalFees > availableForFees ? availableForFees : totalFees;
        
        if (toWithdraw == 0) return;

        // Deduct from fees in order: management first, then performance
        uint256 remaining = toWithdraw;
        
        if (remaining >= accumulatedManagementFees) {
            remaining -= accumulatedManagementFees;
            accumulatedManagementFees = 0;
        } else {
            accumulatedManagementFees -= remaining;
            remaining = 0;
        }
        
        if (remaining > 0) {
            if (remaining >= accumulatedPerformanceFees) {
                accumulatedPerformanceFees = 0;
            } else {
                accumulatedPerformanceFees -= remaining;
            }
        }

        depositToken.safeTransfer(treasury, toWithdraw);

        emit FeesWithdrawn(treasury, toWithdraw, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    function name() external pure returns (string memory) { return "CPool"; }
    function symbol() external pure returns (string memory) { return "cvCRO"; }
    function decimals() external pure returns (uint8) { return 18; }
    function totalSupply() external view returns (uint256) { return totalShares; }
    function balanceOf(address a) external view returns (uint256) { return members[a].shares; }

    /**
     * @notice Calculate total NAV of the pool in USDC terms
     * @dev Uses Pyth Network price feeds for accurate multi-asset valuation
     *      CRITICAL: Reverts if any asset with balance lacks a price feed
     * @return nav Total NAV in USDC (6 decimals)
     */
    function calculateTotalNAV() public view returns (uint256 nav) {
        // Start with USDC balance (6 decimals)
        nav = depositToken.balanceOf(address(this));

        // Add value of each asset using Pyth price feeds
        for (uint8 i = 0; i < NUM_ASSETS; i++) {
            if (assetBalances[i] == 0) continue;
            
            // CRITICAL: Asset has balance - MUST have price feed
            // Cannot skip - would undervalue portfolio and harm depositors
            if (pythPriceIds[i] == bytes32(0)) {
                revert AssetWithoutPriceFeed(i, assetBalances[i]);
            }
            
            // Get price from Pyth oracle
            (bool success, int64 price, int32 expo, uint publishTime) = _getPythPrice(i);
            if (!success) revert OracleCallFailed(i);
            
            // Verify price is valid and not stale
            if (price <= 0) revert NegativePrice(i, int256(price));
            if (block.timestamp - publishTime > priceStaleThreshold) {
                revert StalePriceData(i, publishTime, priceStaleThreshold);
            }
            
            // Pyth prices have variable exponents (typically -8 for USD pairs)
            // Convert to USDC (6 decimals) value
            // assetValue = assetBalance * price * 10^6 / 10^(assetDecimals - expo)
            uint256 assetValue = _calculateAssetValue(
                assetBalances[i],
                uint256(uint64(price)),
                assetDecimals[i],
                expo
            );
            nav += assetValue;
        }

        return nav;
    }
    
    // _calculateAssetValue - delegated to library
    function _calculateAssetValue(
        uint256 balance,
        uint256 price,
        uint8 decimals,
        int32 expo
    ) internal pure returns (uint256) {
        return CommunityPoolLib.calculateAssetValue(balance, price, decimals, expo);
    }
    
    /**
     * @notice Safely get price from Pyth oracle with error handling
     * @param assetIndex Index of the asset
     * @return success Whether the oracle call succeeded
     * @return price The price
     * @return expo Price exponent
     * @return publishTime Timestamp of price
     */
    function _getPythPrice(uint8 assetIndex) internal view returns (
        bool success,
        int64 price,
        int32 expo,
        uint publishTime
    ) {
        if (address(pythOracle) == address(0)) {
            return (false, 0, 0, 0);
        }
        
        try pythOracle.getPriceNoOlderThan(pythPriceIds[assetIndex], priceStaleThreshold) returns (
            IPyth.Price memory priceData
        ) {
            return (true, priceData.price, priceData.expo, priceData.publishTime);
        } catch {
            return (false, 0, 0, 0);
        }
    }

    /**
     * @notice Get NAV per share
     * @return navPerShare NAV per share (6 decimals, USDC-scaled)
     * @dev Formula: (nav_6dec × WAD) / shares_18dec = 6 decimal result
     *      e.g., $0.75 per share returns 750000 (750000 / 1e6 = 0.75)
     */
    function getNavPerShare() external view returns (uint256) {
        return _calculateNavPerShare();
    }

    function _calculateNavPerShare() internal view returns (uint256) {
        // Using virtual offset for consistency with deposit/withdraw calculations
        // This prevents share price manipulation attacks
        uint256 nav = calculateTotalNAV();
        uint256 totalAssetsWithOffset = nav + VIRTUAL_ASSETS;
        uint256 totalSharesWithOffset = totalShares + VIRTUAL_SHARES;
        
        // Result in 6 decimals (USDC-scaled): nav_6dec × WAD / shares_18dec = 6 dec
        // e.g., $1.00 per share = 1,000,000 (formatUnits with 6 decimals = 1.0)
        return totalAssetsWithOffset.mulDiv(WAD, totalSharesWithOffset, Math.Rounding.Floor);
    }

    /**
     * @notice Get member's current value
     * @param member Member address
     * @return shares Member's shares
     * @return valueUSD Current USD value
     * @return percentage Pool ownership percentage (basis points)
     */
    function getMemberPosition(address member) 
        external 
        view 
        returns (uint256 shares, uint256 valueUSD, uint256 percentage) 
    {
        Member storage m = members[member];
        shares = m.shares;
        
        if (totalShares > 0 && shares > 0) {
            // Using virtual offset for consistency with deposit/withdraw
            uint256 nav = calculateTotalNAV();
            uint256 totalAssetsWithOffset = nav + VIRTUAL_ASSETS;
            uint256 totalSharesWithOffset = totalShares + VIRTUAL_SHARES;
            
            // valueUSD (6 dec) = shares (18 dec) * totalAssets (6 dec) / totalShares (18 dec)
            valueUSD = shares.mulDiv(totalAssetsWithOffset, totalSharesWithOffset, Math.Rounding.Floor);
            // percentage in basis points of actual shares (excluding virtual)
            percentage = shares.mulDiv(BPS_DENOMINATOR, totalShares, Math.Rounding.Floor);
        }
    }

    /**
     * @notice Get pool statistics
     */
    function getPoolStats() 
        external 
        view 
        returns (
            uint256 _totalShares,
            uint256 _totalNAV,
            uint256 _memberCount,
            uint256 _sharePrice,
            uint256[NUM_ASSETS] memory _allocations
        ) 
    {
        _totalShares = totalShares;
        _totalNAV = calculateTotalNAV();
        _memberCount = memberList.length;
        _sharePrice = _calculateNavPerShare();
        _allocations = targetAllocationBps;
    }

    // healthCheck() removed - use getPoolStats() for basic health metrics

    /**
     * @notice Get member count
     */
    function getMemberCount() external view returns (uint256) {
        return memberList.length;
    }

    function getRebalanceHistoryCount() external view returns (uint256) {
        return rebalanceHistory.length;
    }

    // checkOracleHealth() removed - use getOraclePrices() for oracle status

    // getOraclePrices() removed - use Pyth SDK directly

    // ═══════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    function setManagementFee(uint256 _feeBps) external onlyRole(FEE_MANAGER_ROLE) {
        if (_feeBps > 500) revert FeeTooHigh();
        managementFeeBps = _feeBps;
    }

    function setPerformanceFee(uint256 _feeBps) external onlyRole(FEE_MANAGER_ROLE) {
        if (_feeBps > 3000) revert FeeTooHigh();
        performanceFeeBps = _feeBps;
    }

    /**
     * @notice Set maximum single deposit amount
     * @dev Critical circuit breaker control for whale protection
     * @param _maxDeposit Maximum deposit in USDC (6 decimals)
     */
    function setMaxSingleDeposit(uint256 _maxDeposit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxDeposit < MIN_DEPOSIT) revert InvalidConfiguration();
        maxSingleDeposit = _maxDeposit;
        emit CircuitBreakerUpdated(0, _maxDeposit);
    }

    /**
     * @notice Set maximum single withdrawal in basis points of total pool
     * @dev Prevents large withdrawals that could destabilize the pool
     * @param _maxBps Maximum withdrawal as percentage of pool (10000 = 100%)
     */
    function setMaxSingleWithdrawalBps(uint256 _maxBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxBps > BPS_DENOMINATOR) revert InvalidConfiguration();
        maxSingleWithdrawalBps = _maxBps;
        emit CircuitBreakerUpdated(1, _maxBps);
    }

    /**
     * @notice Set daily withdrawal cap in basis points of total pool
     * @dev Prevents bank run scenarios by limiting total daily withdrawals
     * @param _dailyCapBps Daily cap as percentage of pool (10000 = 100%)
     */
    function setDailyWithdrawalCapBps(uint256 _dailyCapBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_dailyCapBps > BPS_DENOMINATOR) revert InvalidConfiguration();
        dailyWithdrawalCapBps = _dailyCapBps;
        emit CircuitBreakerUpdated(2, _dailyCapBps);
    }

    /**
     * @notice Set DEX router for swaps
     * @param _dexRouter Address of VVS or other DEX router
     */
    function setDexRouter(address _dexRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dexRouter = _dexRouter;
        emit DexRouterUpdated(_dexRouter);
    }

    /**
     * @notice Set rebalance cooldown period
     * @param _cooldown Minimum time between rebalances in seconds
     */
    function setRebalanceCooldown(uint256 _cooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_cooldown > 7 days) revert InvalidConfiguration();
        rebalanceCooldown = _cooldown;
    }

    /**
     * @notice Set asset token address (for post-initialization configuration)
     * @param assetIndex Index of asset (0=BTC, 1=ETH, 2=SUI, 3=CRO)
     * @param token ERC20 token address
     */
    function setAssetToken(uint8 assetIndex, address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (assetIndex >= NUM_ASSETS) revert InvalidAssetIndex();
        if (token == address(0)) revert ZeroAddress();
        assetTokens[assetIndex] = IERC20(token);
        assetDecimals[assetIndex] = IERC20Metadata(token).decimals();
    }

    /**
     * @notice Set Pyth Network oracle contract address
     * @param _pythOracle Address of Pyth oracle (Cronos: 0xE0d0e68297772Dd5a1f1D99897c581E2082dbA5B)
     */
    function setPythOracle(address _pythOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pythOracle == address(0)) revert ZeroAddress();
        pythOracle = IPyth(_pythOracle);
    }

    /**
     * @notice Set Pyth price ID for an asset
     * @param assetIndex Index of asset (0=BTC, 1=ETH, 2=SUI, 3=CRO)
     * @param priceId Pyth price feed ID (bytes32)
     */
    function setPriceId(uint8 assetIndex, bytes32 priceId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (assetIndex >= NUM_ASSETS) revert InvalidAssetIndex();
        pythPriceIds[assetIndex] = priceId;
        emit PriceFeedSet(assetIndex, address(0)); // Event for tracking
    }

    /**
     * @notice Set price staleness threshold
     * @param threshold Maximum age of price data in seconds (default: 1 hour)
     */
    function setPriceStaleThreshold(uint256 threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (threshold < 60 || threshold > 86400) revert ThresholdOutOfRange();
        priceStaleThreshold = threshold;
    }

    function setEmergencyWithdraw(bool _enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emergencyWithdrawEnabled = _enabled;
    }

    /**
     * @notice Trip circuit breaker - freezes deposits and withdrawals
     * @dev Use in case of oracle failure, exploit detected, or market emergency
     * @param reason Description of why circuit breaker was triggered
     */
    function tripCircuitBreaker(string calldata reason) external onlyRole(DEFAULT_ADMIN_ROLE) {
        circuitBreakerTripped = true;
        emit CircuitBreakerTripped(msg.sender, keccak256(bytes(reason)));
    }

    /**
     * @notice Reset circuit breaker - re-enables normal operations
     * @dev Only call after confirming the emergency has been resolved
     */
    function resetCircuitBreaker() external onlyRole(DEFAULT_ADMIN_ROLE) {
        circuitBreakerTripped = false;
        emit CircuitBreakerReset(msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════
    // RESCUE FUNCTIONS (Emergency Recovery)
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Reset asset balances to zero (emergency fix for testnet)
     * @dev Only callable by admin. Use when assetBalances are corrupted.
     * @param assetIndex Index of asset to reset (0=BTC, 1=ETH, 2=SUI, 3=CRO), or 255 to reset all
     */
    function resetAssetBalance(uint8 assetIndex) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (assetIndex == 255) {
            // Reset all asset balances
            for (uint8 i = 0; i < NUM_ASSETS; i++) {
                assetBalances[i] = 0;
            }
        } else {
            if (assetIndex >= NUM_ASSETS) revert InvalidAssetIndex();
            assetBalances[assetIndex] = 0;
        }
    }

    /**
     * @notice Rescue accidentally sent ETH/CRO to treasury
     * @dev Only callable by admin. Use for recovering stuck native tokens.
     */
    function rescueETH() external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToRescue();
        (bool success, ) = payable(treasury).call{value: balance}("");
        if (!success) revert RescueFailed();
        emit TokensRescued(address(0), balance);
    }

    /**
     * @notice Rescue accidentally sent ERC20 tokens to treasury
     * @dev Cannot rescue deposit token or pool assets - only unknown tokens
     * @param token Address of the ERC20 token to rescue
     */
    function rescueToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(depositToken)) revert CannotRescuePoolToken();
        
        // Prevent rescuing pool assets
        for (uint8 i = 0; i < NUM_ASSETS; i++) {
            if (token == address(assetTokens[i])) revert CannotRescuePoolToken();
        }
        
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert NothingToRescue();
        
        IERC20(token).safeTransfer(treasury, balance);
        emit TokensRescued(token, balance);
    }

    /**
     * @notice Admin migration function - transfers all deposit tokens to a new contract
     * @dev DANGER: Only use for contract migration! Transfers all USDC and resets shares.
     * @param recipient The new contract or address to receive the funds
     */
    function adminMigrateFunds(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (!emergencyWithdrawEnabled) revert EmergencyModeRequired();
        
        uint256 balance = depositToken.balanceOf(address(this));
        if (balance == 0) revert NothingToRescue();
        
        // Transfer all deposit tokens
        depositToken.safeTransfer(recipient, balance);
        
        // Reset pool state
        totalShares = 0;
        
        emit TokensRescued(address(depositToken), balance);
    }

    // ═══════════════════════════════════════════════════════════════
    // AUTO-HEDGE MANAGEMENT (x402 Gasless)
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Set the HedgeExecutor contract address
     * @param _hedgeExecutor Address of the HedgeExecutor contract
     */
    function setHedgeExecutor(address _hedgeExecutor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_hedgeExecutor == address(0)) revert ZeroAddress();
        hedgeExecutor = _hedgeExecutor;
        emit HedgeExecutorSet(_hedgeExecutor);
    }

    /**
     * @notice Configure auto-hedge settings
     * @param _enabled Enable/disable auto-hedging
     * @param _riskThresholdBps Risk level to trigger hedge (e.g., 500 = 5% drawdown)
     * @param _maxHedgeRatioBps Max % of NAV to hedge (e.g., 2500 = 25%)
     * @param _defaultLeverage Default leverage (2-10)
     * @param _cooldownSeconds Min time between auto-hedges
     */
    function setAutoHedgeConfig(
        bool _enabled,
        uint256 _riskThresholdBps,
        uint256 _maxHedgeRatioBps,
        uint256 _defaultLeverage,
        uint256 _cooldownSeconds
    ) external onlyRole(AGENT_ROLE) {
        if (_defaultLeverage < 2 || _defaultLeverage > 10) revert InvalidLeverage();
        if (_maxHedgeRatioBps > 5000) revert MaxHedgeRatioExceeded();
        
        autoHedgeConfig = AutoHedgeConfig({
            enabled: _enabled,
            riskThresholdBps: _riskThresholdBps,
            maxHedgeRatioBps: _maxHedgeRatioBps,
            defaultLeverage: _defaultLeverage,
            cooldownSeconds: _cooldownSeconds,
            lastAutoHedgeTime: autoHedgeConfig.lastAutoHedgeTime
        });
        
        emit AutoHedgeConfigUpdated(_enabled, _riskThresholdBps, _maxHedgeRatioBps, _defaultLeverage);
    }

    /**
     * @notice Open a hedge position for the pool (AI-managed)
     * @dev Called by AGENT_ROLE when risk conditions are met
     * @param pairIndex Asset to hedge (0=BTC, 1=ETH, etc.)
     * @param collateralAmount USDC collateral for the hedge
     * @param leverage Leverage multiplier (2-10)
     * @param isLong Direction (false = SHORT for hedging)
     * @param reason AI reasoning for opening the hedge
     */
    function openPoolHedge(
        uint8 pairIndex,
        uint256 collateralAmount,
        uint256 leverage,
        bool isLong,
        string calldata reason
    ) external payable onlyRole(AGENT_ROLE) nonReentrant whenNotPaused returns (bytes32 hedgeId) {
        if (hedgeExecutor == address(0)) revert HedgeExecutorNotSet();
        if (collateralAmount == 0) revert ZeroAmount();
        
        // Check auto-hedge cooldown
        if (autoHedgeConfig.enabled && 
            block.timestamp < autoHedgeConfig.lastAutoHedgeTime + autoHedgeConfig.cooldownSeconds) {
            revert AutoHedgeCooldownActive(autoHedgeConfig.lastAutoHedgeTime + autoHedgeConfig.cooldownSeconds);
        }
        
        // Ensure we have enough collateral
        uint256 poolBalance = depositToken.balanceOf(address(this));
        if (poolBalance < collateralAmount) revert InsufficientPoolBalance();
        
        // CRITICAL: Enforce minimum reserve ratio (20% of NAV must stay liquid)
        // This ensures members can always withdraw even when hedges are active
        uint256 nav = calculateTotalNAV();
        uint256 minReserve = (nav * MIN_RESERVE_RATIO_BPS) / BPS_DENOMINATOR;
        if (poolBalance - collateralAmount < minReserve) {
            revert ReserveRatioBreached(poolBalance - collateralAmount, minReserve);
        }
        
        // Check max hedge ratio
        uint256 maxHedgeAmount = (nav * autoHedgeConfig.maxHedgeRatioBps) / BPS_DENOMINATOR;
        if (totalHedgedValue + collateralAmount > maxHedgeAmount) revert MaxHedgeRatioExceeded();
        
        // Generate ZK commitment for privacy
        bytes32 commitmentHash = keccak256(abi.encodePacked(
            address(this),
            pairIndex,
            collateralAmount,
            block.timestamp
        ));
        bytes32 nullifier = keccak256(abi.encodePacked(commitmentHash, block.number));
        bytes32 merkleRoot = keccak256(abi.encodePacked(commitmentHash, nullifier));
        
        // Approve HedgeExecutor to spend collateral
        depositToken.safeIncreaseAllowance(hedgeExecutor, collateralAmount);
        
        // Open hedge via HedgeExecutor (x402 gasless compatible)
        hedgeId = IHedgeExecutor(hedgeExecutor).openHedge{value: MOONLANDER_ORACLE_FEE}(
            pairIndex,
            collateralAmount,
            leverage,
            isLong,
            commitmentHash,
            nullifier,
            merkleRoot
        );
        
        // Track the hedge
        activePoolHedges.push(hedgeId);
        isPoolHedge[hedgeId] = true;
        totalHedgedValue += collateralAmount;
        autoHedgeConfig.lastAutoHedgeTime = block.timestamp;
        
        emit PoolHedgeOpened(hedgeId, pairIndex, collateralAmount, leverage, isLong, keccak256(bytes(reason)));
    }

    /**
     * @notice Close a pool hedge position
     * @param hedgeId ID of the hedge to close
     * @param reason AI reasoning for closing
     */
    function closePoolHedge(
        bytes32 hedgeId,
        string calldata reason
    ) external payable onlyRole(AGENT_ROLE) nonReentrant whenNotPaused {
        if (!isPoolHedge[hedgeId]) revert HedgeNotOwnedByPool(hedgeId);
        
        // Get hedge details for PnL calculation
        (,,,, uint256 collateralAmount,,,,,,,, uint8 status) = IHedgeExecutor(hedgeExecutor).hedges(hedgeId);
        if (status != 1) revert HedgeNotActive(); // 1 = ACTIVE
        
        // Close the hedge (no oracle fee needed - HedgeExecutor handles it)
        IHedgeExecutor(hedgeExecutor).closeHedge(hedgeId);
        
        // Get realized PnL
        (,,,,,,,,,,, int256 realizedPnl,) = IHedgeExecutor(hedgeExecutor).hedges(hedgeId);
        
        // Update tracking
        isPoolHedge[hedgeId] = false;
        totalHedgedValue = totalHedgedValue > collateralAmount ? 
            totalHedgedValue - collateralAmount : 0;
        
        // Remove from active hedges array
        for (uint256 i = 0; i < activePoolHedges.length; i++) {
            if (activePoolHedges[i] == hedgeId) {
                activePoolHedges[i] = activePoolHedges[activePoolHedges.length - 1];
                activePoolHedges.pop();
                break;
            }
        }
        
        emit PoolHedgeClosed(hedgeId, realizedPnl, keccak256(bytes(reason)));
    }

    // getActivePoolHedges() removed - read activePoolHedges public array directly
    // getAutoHedgeConfig() removed - read autoHedgeConfig public variable directly
    // shouldAutoHedge() removed - check status off-chain

    // ═══════════════════════════════════════════════════════════════
    // UUPS UPGRADE
    // ═══════════════════════════════════════════════════════════════

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}

    // ═══════════════════════════════════════════════════════════════
    // RECEIVE
    // ═══════════════════════════════════════════════════════════════

    receive() external payable {}
}
