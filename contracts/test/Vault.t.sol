// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Lab} from "./Lab.sol";
import {Token} from "../src/Token.sol";
import {Vault} from "../src/Vault.sol";

/// @notice How an ERC-4626 vault prices shares, and where the rounding lands.
contract VaultTest is Lab {
    /// The address `Vault` expects its asset at, fixed so the vault needs no
    /// constructor and can be placed directly into genesis.
    address internal constant ASSET = 0x00000000000000000000000000000000c0dE0020;

    Token internal token;
    Vault internal vault;

    address internal early = address(0xEA21);
    address internal later = address(0x1A7E);

    function setUp() public {
        // Put a real Token at the address the vault has hard-coded, the same
        // way Cupel's genesis does.
        Token deployed = new Token();
        vm.etch(ASSET, address(deployed).code);
        token = Token(ASSET);

        vault = new Vault();

        token.mint(early, 10_000e18);
        token.mint(later, 10_000e18);

        vm.prank(early);
        token.approve(address(vault), type(uint256).max);
        vm.prank(later);
        token.approve(address(vault), type(uint256).max);
    }

    // --- price, shares, and where the rounding goes ----------------------------

    /// @notice What happens when the share price is very large relative to a
    ///         deposit: the division rounds down, and the remainder stays in
    ///         the vault for the existing share holders.
    ///
    /// A vault's price is `assets / shares`. Transferring assets in *without*
    /// depositing mints no shares, so the price of the shares that already exist
    /// rises — the same mechanism by which yield accrues. Push that price high
    /// enough and the next depositor's `assets * shares / total` rounds down
    /// hard, and what is lost to the rounding belongs to whoever held shares
    /// before.
    ///
    /// This is integer arithmetic doing exactly what it is defined to do. It is
    /// worth seeing once, because every vault that mints on a ratio has to
    /// decide where the remainder goes.
    function test_shares_anInflatedPriceRoundsTheNextDepositDown() public {
        // 1. Seed the vault with the smallest possible position.
        vm.prank(early);
        vault.deposit(1, early);
        assertEq(vault.totalSupply(), 1, "the early depositor holds the only share");

        // 2. Donate. This is the move: it changes totalAssets without changing
        //    totalSupply, so one share is now worth a fortune.
        vm.prank(early);
        token.transfer(address(vault), 1_000e18);
        assertEq(vault.totalAssets(), 1_000e18 + 1, "assets rose, supply did not");

        // 3. A second deposit of 2000, at a price that says this is worth
        //    1.999… shares, and the division rounds down to 1.
        vm.prank(later);
        uint256 laterShares = vault.deposit(2_000e18, later);
        assertEq(laterShares, 1, "the later depositor's 2000 bought a single share");

        // 4. Two shares now split 3000 assets evenly, so each is worth 1500 —
        //    the second deposit was 2000 and the first was 1000 plus a wei.
        vm.prank(later);
        uint256 laterGot = vault.redeem(1, later, later);
        assertEq(laterGot, 1_500e18 + 0, "redeeming that share returns 1500 of the 2000");

        vm.prank(early);
        uint256 earlyGot = vault.redeem(1, early, early);

        // 1000 and a wei went in; 1500 comes out. The difference is the
        // rounding remainder, which belongs to the shares that already existed.
        assertGt(earlyGot, 1_000e18, "the remainder went to the earlier holder");
        assertEq(earlyGot + laterGot, 3_000e18 + 1, "the vault created nothing: the total is conserved");
    }

    /// @notice The floor case, and the check every ratio-minting vault needs.
    ///
    /// A deposit small enough to round down to zero shares is refused outright.
    /// Without that check the vault would accept the assets and mint nothing,
    /// which is a silent loss rather than an error.
    function test_shares_aDepositThatWouldMintNothingIsRefused() public {
        vm.prank(early);
        vault.deposit(1, early);
        vm.prank(early);
        token.transfer(address(vault), 1_000e18);

        uint256 balanceBefore = token.balanceOf(later);

        vm.prank(later);
        vm.expectRevert(Vault.ZeroShares.selector);
        vault.deposit(1_000e18 / 2, later);

        assertEq(token.balanceOf(later), balanceBefore, "the later kept their assets");
    }

    // --- rounding -------------------------------------------------------------

    /// @notice Depositing and immediately redeeming must never be profitable.
    ///
    /// If it were, the trade could be repeated until the vault was empty. Both
    /// conversions round down, which is what makes the round trip lossy rather
    /// than free.
    function test_rounding_aRoundTripNeverGains() public {
        vm.prank(early);
        vault.deposit(1_000e18, early);

        // Make the share price a number that does not divide evenly.
        vm.prank(early);
        token.transfer(address(vault), 333);

        uint256 before = token.balanceOf(later);
        vm.prank(later);
        uint256 shares = vault.deposit(777e18, later);
        vm.prank(later);
        vault.redeem(shares, later, later);

        assertLt(token.balanceOf(later), before + 1, "a round trip cannot profit");
    }

    /// @notice On an empty vault the rate is one to one, because there is no
    ///         supply to divide by.
    function test_firstDepositIsOneToOne() public {
        vm.prank(later);
        uint256 shares = vault.deposit(100e18, later);
        assertEq(shares, 100e18, "first deposit mints at par");
        assertEq(vault.totalAssets(), 100e18, "assets match");
    }

    /// @notice A transfer straight into the vault raises the price for everyone
    ///         already holding shares. This is precisely how yield reaches
    ///         depositors: no new shares, more assets behind each one.
    function test_donationRaisesThePriceForExistingHolders() public {
        vm.prank(later);
        vault.deposit(100e18, later);

        uint256 worthBefore = vault.convertToAssets(100e18);
        vm.prank(early);
        token.transfer(address(vault), 50e18);
        uint256 worthAfter = vault.convertToAssets(100e18);

        assertEq(worthBefore, 100e18, "before the donation");
        assertEq(worthAfter, 150e18, "the holder gained the whole donation");
    }
}
