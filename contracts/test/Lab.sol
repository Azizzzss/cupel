// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The subset of Foundry's cheatcodes these tests use.
///
/// @dev Declared here rather than pulled from `forge-std` so the contracts
///      directory has no submodules and no network fetch — `forge test` works
///      on a fresh clone with nothing installed.
interface Vm {
    /// Set `msg.sender` for the next call only.
    function prank(address sender) external;
    /// Set `msg.sender` for every call until `stopPrank`.
    function startPrank(address sender) external;
    function stopPrank() external;
    /// Set an account's ether balance.
    function deal(address to, uint256 balance) external;
    /// Place runtime bytecode at an address, as genesis does.
    function etch(address target, bytes calldata code) external;
    /// Expect the next call to revert with exactly this data.
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    /// Expect the next call to revert with an error of this type, whatever
    /// arguments it carries. `expectRevert` matches the revert data exactly, so
    /// it only works for errors that take no parameters.
    function expectPartialRevert(bytes4 selector) external;
    /// Derive an address from a private key.
    function addr(uint256 privateKey) external pure returns (address);
    /// Sign a digest with a private key.
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    /// Set `block.timestamp`.
    function warp(uint256 timestamp) external;
    /// Label an address in traces.
    function label(address account, string calldata name) external;
}

/// @notice Base for Cupel's contract tests.
///
/// @dev Foundry finds tests by looking for functions whose name begins with
///      `test`, so this base carries only helpers and is never run itself.
abstract contract Lab {
    /// The address Foundry answers cheatcode calls on.
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    error AssertionFailed(string what, uint256 actual, uint256 expected);
    error AssertionFailedAddress(string what, address actual, address expected);
    error AssertionFailedBool(string what);

    function assertEq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailed(what, actual, expected);
    }

    function assertEq(address actual, address expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailedAddress(what, actual, expected);
    }

    function assertTrue(bool condition, string memory what) internal pure {
        if (!condition) revert AssertionFailedBool(what);
    }

    function assertGt(uint256 actual, uint256 floor, string memory what) internal pure {
        if (actual <= floor) revert AssertionFailed(what, actual, floor);
    }

    function assertLt(uint256 actual, uint256 ceiling, string memory what) internal pure {
        if (actual >= ceiling) revert AssertionFailed(what, actual, ceiling);
    }
}
