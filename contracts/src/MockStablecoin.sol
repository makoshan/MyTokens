// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Mock Stablecoin (test USDT/USDC)
/// @notice A throwaway 6-decimal ERC-20 used ONLY on testnets to validate the
///         "pay stablecoin → receive MYC → burn MYC → credit" flow end to end.
///         It mirrors MyKeyComputeCredit's gasless `transferWithSig` so a freshly
///         minted passkey wallet (no ETH) can pay without holding gas: the user
///         signs an EIP-191 authorization and the gateway relayer submits it.
/// @dev On mainnet (Base) this contract is dropped — real USDC's EIP-3009
///      `transferWithAuthorization` plays the same role. `mint` is owner-gated so
///      the relayer (deployed as owner) can faucet test funds to friends. Name,
///      symbol, and decimals are constructor params so one contract can stand in
///      for either USDT or USDC during validation.
contract MockStablecoin {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// @notice Per-owner nonce for gasless transferWithSig (replay protection).
    mapping(address => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();
    error SigExpired();
    error BadSignature();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    // --- ERC-20 ---

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance();
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    // --- Mint (faucet, owner) ---

    /// @notice Mint test funds to `to`. Owner-gated so the relayer can faucet
    ///         friends on testnet; never used on mainnet.
    function mint(address to, uint256 value) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        unchecked {
            balanceOf[to] += value;
        }
        emit Transfer(address(0), to, value);
    }

    // --- Gasless transfer (meta-tx, EIP-191 personal_sign) ---

    /// @notice Domain tag mixed into the transferWithSig digest so an
    ///         authorization for this token can't be replayed against another
    ///         contract sharing the same scheme.
    bytes32 public constant TRANSFER_WITH_SIG_TAG = keccak256("MockStablecoin.transferWithSig.v1");

    /// @notice Transfer `value` of `from`'s balance to `to`, authorized by
    ///         `from`'s EIP-191 personal_sign. A relayer submits this and pays
    ///         gas, so `from` never needs ETH. Replay-protected by the per-owner
    ///         nonce + the domain tag + this contract's address.
    /// @dev digest = keccak256(abi.encode(TRANSFER_WITH_SIG_TAG, from, to, value,
    ///      nonce, deadline, chainId, address(this))); signed = personal_sign(digest).
    function transferWithSig(
        address from,
        address to,
        uint256 value,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (block.timestamp > deadline) revert SigExpired();
        uint256 nonce = nonces[from];
        bytes32 digest = keccak256(
            abi.encode(TRANSFER_WITH_SIG_TAG, from, to, value, nonce, deadline, block.chainid, address(this))
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address signer = _recover(ethHash, sig);
        if (signer == address(0) || signer != from) revert BadSignature();
        nonces[from] = nonce + 1;
        _transfer(from, to, value);
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }

    // --- Ownership ---

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
