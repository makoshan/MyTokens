// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockStablecoin} from "../src/MockStablecoin.sol";

/// Minimal forge cheatcode interface — avoids a forge-std dependency.
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

/// Mirrors TransferWithSig.t.sol — the stablecoin reuses the same gasless
/// transfer scheme so a no-ETH passkey wallet can pay the relayer for MYC.
contract MockStablecoinTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    MockStablecoin token;
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant MALLORY_PK = 0xBADBAD;
    address alice;
    address relayer = address(0xCAFE);

    function setUp() public {
        alice = vm.addr(ALICE_PK);
        token = new MockStablecoin("Tether USD (test)", "USDT", 6, address(this)); // owner = test contract
        token.mint(alice, 100e6);
        vm.warp(1_000_000);
    }

    function _sigDigest(
        address from,
        address to,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 tag = keccak256("MockStablecoin.transferWithSig.v1");
        bytes32 digest = keccak256(abi.encode(tag, from, to, value, nonce, deadline, block.chainid, address(token)));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    function _sign(uint256 pk, bytes32 ethHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function testMetadata() public view {
        require(keccak256(bytes(token.symbol())) == keccak256("USDT"), "symbol");
        require(token.decimals() == 6, "decimals");
    }

    function testGaslessPayToRelayerBumpsNonce() public {
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(ALICE_PK, _sigDigest(alice, relayer, 30e6, 0, deadline));

        vm.prank(relayer); // relayer submits + pays gas; alice holds no ETH
        token.transferWithSig(alice, relayer, 30e6, deadline, sig);

        require(token.balanceOf(alice) == 70e6, "alice balance");
        require(token.balanceOf(relayer) == 30e6, "relayer received USDT");
        require(token.nonces(alice) == 1, "nonce bumped");
    }

    function testReplayReverts() public {
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(ALICE_PK, _sigDigest(alice, relayer, 30e6, 0, deadline));
        token.transferWithSig(alice, relayer, 30e6, deadline, sig);

        vm.expectRevert(MockStablecoin.BadSignature.selector);
        token.transferWithSig(alice, relayer, 30e6, deadline, sig);
    }

    function testExpiredReverts() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(ALICE_PK, _sigDigest(alice, relayer, 30e6, 0, deadline));
        vm.expectRevert(MockStablecoin.SigExpired.selector);
        token.transferWithSig(alice, relayer, 30e6, deadline, sig);
    }

    function testWrongSignerReverts() public {
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(MALLORY_PK, _sigDigest(alice, relayer, 30e6, 0, deadline));
        vm.expectRevert(MockStablecoin.BadSignature.selector);
        token.transferWithSig(alice, relayer, 30e6, deadline, sig);
    }

    function testMintIsOwnerOnly() public {
        vm.expectRevert(MockStablecoin.NotOwner.selector);
        vm.prank(alice);
        token.mint(alice, 1e6);
    }
}
