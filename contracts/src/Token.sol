// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Token — an ERC-20 you are meant to break
/// @notice A complete, readable ERC-20 with EIP-2612 permits, deployed at a
///         fixed address on every Cupel chain. Anyone may mint: this is a lab,
///         and having to beg a faucet for test tokens helps nobody.
///
/// @dev Read this contract for the comments as much as the code. Each one marks
///      something that has cost real money on mainnet.
contract Token {
    string public constant name = "Cupel Token";
    string public constant symbol = "CUP";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    /// @notice Remaining allowance of `spender` over `owner`'s tokens.
    ///
    /// @dev **The approve race.** Changing a non-zero allowance to another
    ///      non-zero value is two states with a gap between them. A spender
    ///      watching the mempool can see the change coming, spend the old
    ///      allowance first, and then spend the new one — taking the sum of
    ///      both rather than the amount you intended.
    ///
    ///      Nothing here prevents it, deliberately: the standard behaviour is
    ///      what you need to be able to observe. `test/Token.t.sol` performs
    ///      the attack. The mitigations are to set the allowance to zero first,
    ///      or to use `increaseAllowance`/`decreaseAllowance`, or to use
    ///      `permit` with a fresh nonce each time.
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Per-owner permit nonce, so a signature cannot be replayed.
    mapping(address => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);
    error PermitExpired(uint256 deadline, uint256 blockTimestamp);
    error InvalidSigner(address recovered, address expected);

    /// @notice Create tokens out of nothing. A lab convenience, not a pattern.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Destroy tokens held by the caller.
    function burn(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        unchecked {
            balanceOf[msg.sender] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(msg.sender, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @dev Returns `bool` because the standard says so. Note that plenty of
    ///      real tokens — USDT among them — return nothing at all, which is why
    ///      integrations should use a safe-transfer wrapper rather than trusting
    ///      the declared return type.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An allowance of max uint256 is treated as infinite and never
        // decremented. This is a widespread convention rather than a rule in
        // the standard, and it saves a storage write on every transfer.
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(allowed, amount);
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Approve by signature (EIP-2612), so an approval costs no gas and
    ///         no separate transaction.
    ///
    /// @dev The signature commits to a deadline and to a nonce that increments
    ///      on use, so it can be neither replayed nor held indefinitely.
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > deadline) revert PermitExpired(deadline, block.timestamp);

        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));

        address recovered = ecrecover(digest, v, r, s);
        // ecrecover returns the zero address for a malformed signature rather
        // than reverting, so comparing against `owner` is not enough on its own
        // when `owner` could itself be zero.
        if (recovered == address(0) || recovered != owner) {
            revert InvalidSigner(recovered, owner);
        }

        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @notice EIP-712 domain separator.
    ///
    /// @dev Computed on each call rather than cached at construction. Caching is
    ///      cheaper, but a cached separator is wrong for every chain the
    ///      contract is later deployed to at the same address, and after a
    ///      chain splits. Here it also means the contract can be placed
    ///      directly into genesis, since nothing has to run first.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function _transfer(address from, address to, uint256 amount) private {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        unchecked {
            balanceOf[from] = balance - amount;
            // Cannot overflow: the sum of all balances is `totalSupply`, which
            // is checked on the way in.
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
