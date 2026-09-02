// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Weth — wrapped ether
/// @notice Ether that behaves like an ERC-20, because ether itself does not.
///         Send ether to this contract and receive an equal balance of WETH;
///         withdraw to get it back.
///
/// @dev This is the canonical WETH9 design rewritten for a modern compiler and
///      annotated. It is the single most-integrated contract on Ethereum, and
///      the reason is boring: every AMM and lending market wants one interface
///      for value, and native ether has no `transferFrom`.
contract Weth {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed to, uint256 value);
    event Withdrawal(address indexed from, uint256 value);

    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);
    error EtherTransferFailed();

    /// @notice Wrap ether by sending it here with no calldata.
    receive() external payable {
        deposit();
    }

    /// @notice Wrap ether.
    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
        // Minting is reported as a transfer from the zero address so that
        // indexers tracking `Transfer` see supply appear.
        emit Transfer(address(0), msg.sender, msg.value);
    }

    /// @notice Unwrap ether.
    ///
    /// @dev State is updated **before** the ether is sent. `call` hands control
    ///      to the recipient, and a contract recipient can call straight back
    ///      into `withdraw`; if the balance were still standing at that moment
    ///      it could be withdrawn repeatedly. This ordering — effects, then
    ///      interaction — is the whole defence.
    function withdraw(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        unchecked {
            balanceOf[msg.sender] = balance - amount;
        }

        emit Withdrawal(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);

        // `call` rather than `transfer`: the 2300 gas stipend that `transfer`
        // imposes has broken withdrawals for smart-contract wallets before, and
        // gas costs change between forks.
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert EtherTransferFailed();
    }

    /// @notice Total WETH in existence, which is exactly the ether held here.
    ///
    /// @dev Derived rather than tracked, so the invariant cannot drift. Note
    ///      that ether force-sent via `selfdestruct` would inflate this above
    ///      the sum of balances — a discrepancy no one can withdraw.
    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return transferFrom(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(balance, amount);

        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) {
                if (allowed < amount) revert InsufficientAllowance(allowed, amount);
                unchecked {
                    allowance[from][msg.sender] = allowed - amount;
                }
            }
        }

        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
