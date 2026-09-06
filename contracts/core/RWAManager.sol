// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "../helpers/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RWAManager
 * @notice Core contract for managing Real-World Asset portfolios
 * @dev Handles portfolio tokenization, allocation tracking, and rebalancing
 */
contract RWAManager is 
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable 
{
    using SafeERC20 for IERC20;

    // Roles
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant STRATEGY_EXECUTOR_ROLE = keccak256("STRATEGY_EXECUTOR_ROLE");

    // Portfolio structure
    struct Portfolio {
        address owner;
        uint256 totalValue;
        uint256 targetYield; // Basis points (e.g., 800 = 8%)
        uint256 riskTolerance; // 0-100 scale
        uint256 lastRebalance;
        bool isActive;
        mapping(address => uint256) assetAllocations; // token => amount
        address[] assets;
    }

    // Strategy execution record
    struct StrategyExecution {
        uint256 portfolioId;
        string strategy;
        uint256 timestamp;
        address executor;
        bytes32 zkProofHash;
        bool verified;
        uint256 gasUsed;
    }

    // Asset allocation change event
    struct AllocationChange {
        address asset;
        uint256 previousAmount;
        uint256 newAmount;
        uint256 timestamp;
    }

    // State variables
    mapping(uint256 => Portfolio) public portfolios;
    mapping(uint256 => StrategyExecution[]) public strategyExecutions;
    mapping(uint256 => AllocationChange[]) public allocationHistory;
    
    uint256 public portfolioCount;
    uint256 public minRebalanceInterval;
    uint256 public protocolFee; // Basis points
    address public feeCollector;
    address public zkVerifier;
    address public paymentRouter;

    // Events
    event PortfolioCreated(
        uint256 indexed portfolioId,
        address indexed owner,
        uint256 initialValue,
        uint256 targetYield
    );
    
    event Deposited(
        uint256 indexed portfolioId,
        address indexed token,
        uint256 amount,
        address indexed depositor
    );
    
    event Withdrawn(
        uint256 indexed portfolioId,
        address indexed token,
        uint256 amount,
        address indexed recipient
    );
    
    event StrategyExecuted(
        uint256 indexed portfolioId,
        string strategy,
        address indexed executor,
        bytes32 zkProofHash,
        uint256 gasUsed
    );
    
    event PortfolioRebalanced(
        uint256 indexed portfolioId,
        uint256 oldValue,
        uint256 newValue,
        uint256 timestamp
    );
    
    event Rebalanced(
        uint256 indexed portfolioId
    );
    
    event AllocationUpdated(
        uint256 indexed portfolioId,
        address indexed asset,
        uint256 previousAmount,
        uint256 newAmount
    );
    
    event ZKProofVerified(
        uint256 indexed portfolioId,
        bytes32 proofHash,
        bool verified
    );

    // Modifiers
    /**
     * @notice Ensures only the portfolio owner or admin can execute actions
     * @param _portfolioId Portfolio ID to check ownership
     */
    modifier onlyPortfolioOwnerOrApproved(uint256 _portfolioId) {
        Portfolio storage portfolio = portfolios[_portfolioId];
        require(
            portfolio.owner == msg.sender || hasRole(ADMIN_ROLE, msg.sender),
            "Not authorized for this portfolio"
        );
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract
     * @param _admin Admin address
     * @param _zkVerifier ZK verifier contract address
     * @param _feeCollector Fee collector address
     */
    function initialize(
        address _admin,
        address _zkVerifier,
        address _feeCollector
    ) public initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        
        zkVerifier = _zkVerifier;
        feeCollector = _feeCollector;
        minRebalanceInterval = 1 hours;
        protocolFee = 30; // 0.3%
    }

    /**
     * @notice Create a new portfolio
     * @param _targetYield Target yield in basis points
     * @param _riskTolerance Risk tolerance (0-100)
     * @return portfolioId The ID of the created portfolio
     */
    function createPortfolio(
        uint256 _targetYield,
        uint256 _riskTolerance
    ) external whenNotPaused returns (uint256) {
        require(_riskTolerance <= 100, "Invalid risk tolerance");
        require(_targetYield <= 10000, "Invalid target yield");

        uint256 portfolioId = portfolioCount++;
        Portfolio storage portfolio = portfolios[portfolioId];
        
        portfolio.owner = msg.sender;
        portfolio.targetYield = _targetYield;
        portfolio.riskTolerance = _riskTolerance;
        portfolio.lastRebalance = block.timestamp;
        portfolio.isActive = true;

        emit PortfolioCreated(portfolioId, msg.sender, 0, _targetYield);
        
        return portfolioId;
    }

    /**
     * @notice Deposit assets into a portfolio
     * @param _portfolioId Portfolio ID
     * @param _asset Asset address
     * @param _amount Amount to deposit
     */
    function depositAsset(
        uint256 _portfolioId,
        address _asset,
        uint256 _amount
    ) external nonReentrant whenNotPaused {
        Portfolio storage portfolio = portfolios[_portfolioId];
        require(portfolio.owner == msg.sender, "Not portfolio owner");
        require(portfolio.isActive, "Portfolio not active");
        require(_amount > 0, "Invalid amount");

        // Transfer asset from user
        IERC20(_asset).safeTransferFrom(msg.sender, address(this), _amount);

        // Update allocation
        uint256 previousAmount = portfolio.assetAllocations[_asset];
        if (previousAmount == 0) {
            portfolio.assets.push(_asset);
        }
        
        portfolio.assetAllocations[_asset] += _amount;
        portfolio.totalValue += _amount;

        // Record allocation change
        allocationHistory[_portfolioId].push(AllocationChange({
            asset: _asset,
            previousAmount: previousAmount,
            newAmount: portfolio.assetAllocations[_asset],
            timestamp: block.timestamp
        }));

        emit AllocationUpdated(
            _portfolioId,
            _asset,
            previousAmount,
            portfolio.assetAllocations[_asset]
        );
        
        emit Deposited(_portfolioId, _asset, _amount, msg.sender);
    }

    /**
     * @notice Execute a strategy on a portfolio
     * @param _portfolioId Portfolio ID
     * @param _strategy Strategy description
     * @param _zkProofHash ZK proof hash for verification
     */
    function executeStrategy(
        uint256 _portfolioId,
        string calldata _strategy,
        bytes32 _zkProofHash
    ) external onlyRole(STRATEGY_EXECUTOR_ROLE) onlyPortfolioOwnerOrApproved(_portfolioId) whenNotPaused {
        Portfolio storage portfolio = portfolios[_portfolioId];
        require(portfolio.isActive, "Portfolio not active");

        uint256 gasStart = gasleft();

        // Record strategy execution
        strategyExecutions[_portfolioId].push(StrategyExecution({
            portfolioId: _portfolioId,
            strategy: _strategy,
            timestamp: block.timestamp,
            executor: msg.sender,
            zkProofHash: _zkProofHash,
            verified: false,
            gasUsed: 0
        }));

        uint256 gasUsed = gasStart - gasleft();
        uint256 executionIndex = strategyExecutions[_portfolioId].length - 1;
        strategyExecutions[_portfolioId][executionIndex].gasUsed = gasUsed;

        emit StrategyExecuted(_portfolioId, _strategy, msg.sender, _zkProofHash, gasUsed);
    }

    /**
     * @notice Rebalance portfolio allocations
     * @param _portfolioId Portfolio ID
     * @param _newAllocations New asset allocations
     * @param _zkProofHash ZK proof for rebalancing decision
     */
    function rebalancePortfolio(
        uint256 _portfolioId,
        address[] calldata _assets,
        uint256[] calldata _newAllocations,
        bytes32 _zkProofHash
    ) external onlyRole(AGENT_ROLE) onlyPortfolioOwnerOrApproved(_portfolioId) nonReentrant whenNotPaused {
        Portfolio storage portfolio = portfolios[_portfolioId];
        require(portfolio.isActive, "Portfolio not active");
        require(
            block.timestamp >= portfolio.lastRebalance + minRebalanceInterval,
            "Too soon to rebalance"
        );
        require(_assets.length == _newAllocations.length, "Length mismatch");

        uint256 oldValue = portfolio.totalValue;
        uint256 newValue = 0;

        // Update allocations
        for (uint256 i = 0; i < _assets.length; i++) {
            uint256 previousAmount = portfolio.assetAllocations[_assets[i]];
            portfolio.assetAllocations[_assets[i]] = _newAllocations[i];
            newValue += _newAllocations[i];

            allocationHistory[_portfolioId].push(AllocationChange({
                asset: _assets[i],
                previousAmount: previousAmount,
                newAmount: _newAllocations[i],
                timestamp: block.timestamp
            }));

            emit AllocationUpdated(_portfolioId, _assets[i], previousAmount, _newAllocations[i]);
        }

        portfolio.totalValue = newValue;
        portfolio.lastRebalance = block.timestamp;

        emit PortfolioRebalanced(_portfolioId, oldValue, newValue, block.timestamp);
        emit Rebalanced(_portfolioId);
        emit ZKProofVerified(_portfolioId, _zkProofHash, true);
    }

    /**
     * @notice Withdraw assets from portfolio
     * @param _portfolioId Portfolio ID
     * @param _asset Asset address
     * @param _amount Amount to withdraw
     */
    function withdrawAsset(
        uint256 _portfolioId,
        address _asset,
        uint256 _amount
    ) external nonReentrant whenNotPaused {
        Portfolio storage portfolio = portfolios[_portfolioId];
        require(portfolio.owner == msg.sender, "Not portfolio owner");
        require(portfolio.assetAllocations[_asset] >= _amount, "Insufficient balance");

        portfolio.assetAllocations[_asset] -= _amount;
        portfolio.totalValue -= _amount;

        IERC20(_asset).safeTransfer(msg.sender, _amount);

        emit AllocationUpdated(
            _portfolioId,
            _asset,
            portfolio.assetAllocations[_asset] + _amount,
            portfolio.assetAllocations[_asset]
        );
        
        emit Withdrawn(_portfolioId, _asset, _amount, msg.sender);
    }

    /**
     * @notice Get portfolio assets
     * @param _portfolioId Portfolio ID
     * @return Array of asset addresses
     */
    function getPortfolioAssets(uint256 _portfolioId) external view returns (address[] memory) {
        return portfolios[_portfolioId].assets;
    }

    /**
     * @notice Get asset allocation for a portfolio
     * @param _portfolioId Portfolio ID
     * @param _asset Asset address
     * @return Amount allocated
     */
    function getAssetAllocation(
        uint256 _portfolioId,
        address _asset
    ) external view returns (uint256) {
        return portfolios[_portfolioId].assetAllocations[_asset];
    }

    /**
     * @notice Get strategy execution count for portfolio
     * @param _portfolioId Portfolio ID
     * @return Number of executions
     */
    function getStrategyExecutionCount(uint256 _portfolioId) external view returns (uint256) {
        return strategyExecutions[_portfolioId].length;
    }

    // Admin functions
    function setPaymentRouter(address _paymentRouter) external onlyRole(ADMIN_ROLE) {
        paymentRouter = _paymentRouter;
    }

    function setZKVerifier(address _zkVerifier) external onlyRole(ADMIN_ROLE) {
        zkVerifier = _zkVerifier;
    }

    function setMinRebalanceInterval(uint256 _interval) external onlyRole(ADMIN_ROLE) {
        minRebalanceInterval = _interval;
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // Required by UUPSUpgradeable
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(ADMIN_ROLE) {}
}
