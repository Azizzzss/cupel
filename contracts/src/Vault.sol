// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title Vault — an ERC-4626 tokenised vault, with its rounding on display
/// @notice Deposit `Token`, receive shares; redeem shares, receive `Token`.
///         The exchange rate moves when the vault's asset balance changes
///         without shares being minted — which anyone can cause by simply
///         transferring tokens in.
///
/// @dev The interesting part of ERC-4626 is not the interface, it is that every
///      conversion is a division, and every division has to round *somewhere*.
///      Round the wrong way and you have handed out value.
contract Vault {
    string public constant name = "Cupel Vault";
    string public constant symbol = "cupCUP";
    uint8 public constant decimals = 18;

    /// @notice The underlying asset. Fixed at the address Cupel deploys `Token`
    ///         to, so the vault needs no constructor and can live in genesis.
    IERC20 public constant asset = IERC20(0x00000000000000000000000000000000c0dE0020);

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );

    error ZeroShares();
    error InsufficientShares(uint256 available, uint256 required);
    error TransferFailed();

    /// @notice Assets the vault holds.
    ///
    /// @dev Reading the balance rather than tracking a counter is what makes the
    ///      share price rise when someone donates tokens — and what makes the
    ///      share price move sharply on a nearly empty vault. See
    ///      `test/Vault.t.sol`.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Shares that `assets` would buy right now.
    ///
    /// @dev Rounds **down**, in the vault's favour. A depositor who rounds up
    ///      here would receive a fraction more than they paid for, and repeating
    ///      that with dust drains the vault one wei at a time.
    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        // First deposit sets the rate one-to-one; there is nothing to divide by.
        if (supply == 0) return assets;
        return (assets * supply) / totalAssets();
    }

    /// @notice Assets that `shares` are currently worth.
    ///
    /// @dev Also rounds **down**, again in the vault's favour: a redeemer gets
    ///      no more than their share is worth.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return shares;
        return (shares * totalAssets()) / supply;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        // Rounding down means a small enough deposit buys zero shares. Taking
        // the assets anyway would be a silent loss, so refuse instead.
        if (shares == 0) revert ZeroShares();

        // Pull first, mint second. The share price is read inside
        // `convertToShares` *before* the assets arrive, which is the ordering
        // ERC-4626 requires — computing it afterwards would price the deposit
        // against itself.
        if (!asset.transferFrom(msg.sender, address(this), assets)) revert TransferFailed();

        totalSupply += shares;
        balanceOf[receiver] += shares;

        emit Transfer(address(0), receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        if (msg.sender != owner) {
            uint256 allowed = allowance[owner][msg.sender];
            if (allowed != type(uint256).max) {
                if (allowed < shares) revert InsufficientShares(allowed, shares);
                unchecked {
                    allowance[owner][msg.sender] = allowed - shares;
                }
            }
        }

        assets = convertToAssets(shares);

        uint256 balance = balanceOf[owner];
        if (balance < shares) revert InsufficientShares(balance, shares);
        unchecked {
            balanceOf[owner] = balance - shares;
            totalSupply -= shares;
        }

        if (!asset.transfer(receiver, assets)) revert TransferFailed();

        emit Transfer(owner, address(0), shares);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    // --- the share token itself ---

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert InsufficientShares(balance, amount);
        unchecked {
            balanceOf[msg.sender] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
