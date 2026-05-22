// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MyKeyComputeCredit} from "../src/MyKeyComputeCredit.sol";

/// Minimal forge cheatcode interface — avoids a forge-std dependency.
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

contract TransferWithSigTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    MyKeyComputeCredit token;
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant MALLORY_PK = 0xBADBAD;
    address alice;
    address bob = address(0xB0B);
    address relayer = address(0xCAFE);

    function setUp() public {
        alice = vm.addr(ALICE_PK);
        token = new MyKeyComputeCredit(address(this)); // owner = test contract
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
        bytes32 tag = keccak256("MYC.transferWithSig.v1");
        bytes32 digest = keccak256(abi.encode(tag, from, to, value, nonce, deadline, block.chainid, address(token)));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    function _sign(uint256 pk, bytes32 ethHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function testTransferWithSigMovesBalanceAndBumpsNonce() public {
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(ALICE_PK, _sigDigest(alice, bob, 30e6, 0, deadline));

        vm.prank(relayer); // relayer submits + pays gas
        token.transferWithSig(alice, bob, 30e6, deadline, sig);

        require(token.balanceOf(alice) == 70e6, "alice balance");
        require(token.balanceOf(bob) == 30e6, "bob balance");
        require(token.nonces(alice) == 1, "nonce bumped");
    }

    function testReplayReverts() public {
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(ALICE_PK, _sigDigest(alice, bob, 30e6, 0, deadline));
        token.transferWithSig(alice, bob, 30e6, deadline, sig);

        // Same sig again: nonce is now 1, so the recovered signer no longer matches.
        vm.expectRevert(MyKeyComputeCredit.BadSignature.selector);
        token.transferWithSig(alice, bob, 30e6, deadline, sig);
    }

    function testExpiredReverts() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(ALICE_PK, _sigDigest(alice, bob, 30e6, 0, deadline));
        vm.expectRevert(MyKeyComputeCredit.SigExpired.selector);
        token.transferWithSig(alice, bob, 30e6, deadline, sig);
    }

    function testWrongSignerReverts() public {
        uint256 deadline = block.timestamp + 3600;
        // Mallory signs an authorization claiming to move Alice's funds.
        bytes memory sig = _sign(MALLORY_PK, _sigDigest(alice, bob, 30e6, 0, deadline));
        vm.expectRevert(MyKeyComputeCredit.BadSignature.selector);
        token.transferWithSig(alice, bob, 30e6, deadline, sig);
    }

    function testInsufficientBalanceReverts() public {
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(ALICE_PK, _sigDigest(alice, bob, 200e6, 0, deadline));
        vm.expectRevert(MyKeyComputeCredit.InsufficientBalance.selector);
        token.transferWithSig(alice, bob, 200e6, deadline, sig);
    }
}
