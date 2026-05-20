// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MyKey Compute Credit (MYC)
/// @notice Standard ERC-20 used as a prepaid compute voucher for the MyKey
///         gateway. Friends burn MYC (deflationary) to buy AI compute credits;
///         the gateway watches the BurnWithMemo event and credits balance off
///         chain at 1 MYC = $1. The operator (owner) mints MYC to friends.
/// @dev Self-contained, no external deps. 6 decimals so raw amount maps 1:1 to
///      micro-USD when 1 MYC = $1. EIP-1559 / standard EVM — signs with any
///      wallet (tcx-wasm, MetaMask) on Base.
contract MyKeyComputeCredit {
    string public constant name = "MyKey Compute Credit";
    string public constant symbol = "MYC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// @notice Per-owner nonce for gasless burnWithSig (replay protection).
    mapping(address => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    /// @notice Emitted on every burn; `memo` lets the gateway attribute the
    ///         purchase to a buyer account. topic0 is keccak256 of this sig.
    event BurnWithMemo(address indexed from, uint256 value, bytes32 indexed memo);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
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

    // --- Mint (operator) ---

    function mint(address to, uint256 value) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        unchecked {
            balanceOf[to] += value;
        }
        emit Transfer(address(0), to, value);
    }

    // --- Burn (anyone, self) ---

    function burn(uint256 value) external {
        _burn(msg.sender, value, bytes32(0));
    }

    /// @notice Burn your own MYC with a memo. The gateway reads `memo` to
    ///         attribute the credit to a buyer account.
    function burnWithMemo(uint256 value, bytes32 memo) external {
        _burn(msg.sender, value, memo);
    }

    function _burn(address from, uint256 value, bytes32 memo) internal {
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            totalSupply -= value;
        }
        emit Transfer(from, address(0), value);
        emit BurnWithMemo(from, value, memo);
    }

    // --- Gasless burn (meta-tx, EIP-191 personal_sign) ---

    error SigExpired();
    error BadSignature();

    /// @notice Burn `value` of `from`'s MYC, authorized by `from`'s EIP-191
    ///         personal_sign over the burn params. A relayer submits this and
    ///         pays gas, so `from` never needs ETH. Replay-protected by nonce.
    /// @dev digest = keccak256(abi.encode(from, value, memo, nonce, deadline,
    ///      chainId, address(this))); signed message = personal_sign(digest).
    function burnWithSig(
        address from,
        uint256 value,
        bytes32 memo,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (block.timestamp > deadline) revert SigExpired();
        uint256 nonce = nonces[from];
        bytes32 digest = keccak256(abi.encode(from, value, memo, nonce, deadline, block.chainid, address(this)));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address signer = _recover(ethHash, sig);
        if (signer == address(0) || signer != from) revert BadSignature();
        nonces[from] = nonce + 1;
        _burn(from, value, memo);
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
