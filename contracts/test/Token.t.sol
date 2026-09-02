// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Lab} from "./Lab.sol";
import {Token} from "../src/Token.sol";

/// @notice Tests that demonstrate rather than merely check.
///
/// @dev Each of these is something you can reproduce by hand against a running
///      Cupel chain. The test is here so the behaviour is pinned; the point is
///      the behaviour.
contract TokenTest is Lab {
    Token internal token;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal spender = address(0x5EEDED);

    function setUp() public {
        token = new Token();
        token.mint(alice, 1000e18);
    }

    // --- the approve race -----------------------------------------------------

    /// @notice The attack the ERC-20 allowance comment warns about.
    ///
    /// Alice approves 100. She changes her mind and approves 50 instead. A
    /// spender watching the mempool spends the 100 *before* her change lands,
    /// then spends the 50 after — taking 150, when she never intended more
    /// than 100 at any moment.
    function test_approveRace_spenderTakesBothAllowances() public {
        vm.prank(alice);
        token.approve(spender, 100e18);

        // The spender front-runs the change and drains the old allowance.
        vm.prank(spender);
        token.transferFrom(alice, bob, 100e18);

        // Alice's transaction now lands, setting a fresh allowance.
        vm.prank(alice);
        token.approve(spender, 50e18);

        vm.prank(spender);
        token.transferFrom(alice, bob, 50e18);

        assertEq(token.balanceOf(bob), 150e18, "spender took both allowances");
        assertEq(token.balanceOf(alice), 850e18, "alice paid for both");
    }

    /// @notice The mitigation: go through zero.
    ///
    /// A spender who front-runs the reset can still take the first 100 — but
    /// the second approval then fails to be a surprise, because Alice can see
    /// the allowance was already spent before she raises it again.
    function test_approveRace_zeroingFirstMakesTheRaceVisible() public {
        vm.startPrank(alice);
        token.approve(spender, 100e18);
        token.approve(spender, 0);
        token.approve(spender, 50e18);
        vm.stopPrank();

        assertEq(token.allowance(alice, spender), 50e18, "final allowance");
    }

    // --- allowance semantics --------------------------------------------------

    /// @notice An infinite allowance is never decremented, which saves a storage
    ///         write per transfer and is why most integrations request it.
    function test_infiniteAllowanceIsNotDecremented() public {
        vm.prank(alice);
        token.approve(spender, type(uint256).max);

        vm.prank(spender);
        token.transferFrom(alice, bob, 400e18);

        assertEq(token.allowance(alice, spender), type(uint256).max, "infinite allowance stays infinite");
    }

    function test_spendingBeyondAllowanceReverts() public {
        vm.prank(alice);
        token.approve(spender, 10e18);

        vm.prank(spender);
        vm.expectPartialRevert(Token.InsufficientAllowance.selector);
        token.transferFrom(alice, bob, 11e18);
    }

    function test_spendingBeyondBalanceReverts() public {
        vm.prank(alice);
        vm.expectPartialRevert(Token.InsufficientBalance.selector);
        token.transfer(bob, 1001e18);
    }

    // --- permit ---------------------------------------------------------------

    /// @notice A permit is an approval that costs the owner no gas and no
    ///         transaction: they sign, someone else submits.
    function test_permit_approvesBySignature() public {
        uint256 key = 0xA11CE5EC;
        address owner = vm.addr(key);
        token.mint(owner, 100e18);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(owner, spender, 25e18, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        // Anyone may submit it — note the caller is not the owner.
        vm.prank(bob);
        token.permit(owner, spender, 25e18, deadline, v, r, s);

        assertEq(token.allowance(owner, spender), 25e18, "permit set the allowance");
        assertEq(token.nonces(owner), 1, "nonce consumed");
    }

    /// @notice The nonce is what stops a signature being used twice.
    function test_permit_cannotBeReplayed() public {
        uint256 key = 0xA11CE5EC;
        address owner = vm.addr(key);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = _permitDigest(owner, spender, 25e18, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        token.permit(owner, spender, 25e18, deadline, v, r, s);

        // The same signature a second time now hashes against nonce 1, so it
        // recovers to somebody else entirely.
        vm.expectPartialRevert(Token.InvalidSigner.selector);
        token.permit(owner, spender, 25e18, deadline, v, r, s);
    }

    /// @notice A signature that sat around too long stops working.
    function test_permit_expires() public {
        uint256 key = 0xA11CE5EC;
        address owner = vm.addr(key);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = _permitDigest(owner, spender, 25e18, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        vm.warp(deadline + 1);
        vm.expectPartialRevert(Token.PermitExpired.selector);
        token.permit(owner, spender, 25e18, deadline, v, r, s);
    }

    /// @notice A signature made for another chain must not work on this one.
    ///
    /// @dev This is what the `chainId` in the EIP-712 domain is for. Forging a
    ///      digest with a different chain id produces a signature that recovers
    ///      to the wrong address here.
    function test_permit_isBoundToTheChain() public {
        uint256 key = 0xA11CE5EC;
        address owner = vm.addr(key);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 foreignDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(token.name())),
                keccak256("1"),
                uint256(999999), // some other chain
                address(token)
            )
        );
        bytes32 structHash = keccak256(abi.encode(token.PERMIT_TYPEHASH(), owner, spender, 25e18, uint256(0), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", foreignDomain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        vm.expectPartialRevert(Token.InvalidSigner.selector);
        token.permit(owner, spender, 25e18, deadline, v, r, s);
    }

    // --- supply ---------------------------------------------------------------

    function test_burnReducesSupply() public {
        uint256 before = token.totalSupply();
        vm.prank(alice);
        token.burn(100e18);
        assertEq(token.totalSupply(), before - 100e18, "supply fell");
        assertEq(token.balanceOf(alice), 900e18, "balance fell");
    }

    function _permitDigest(address owner, address spenderAddress, uint256 value, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), owner, spenderAddress, value, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }
}
