"""Generates the expected byte strings used as fixtures in the board-ble unit tests.

Everything is produced by the reference implementation itself (ha_tuya_ble, MIT —
https://github.com/ha-tuya-ble/ha_tuya_ble), not by a re-typed copy of it: the vendored
`tuya_ble` package is imported directly and `TuyaBLEDevice._build_packets` is called
with a monkeypatched `secrets.token_bytes` so the IV is deterministic.

The only inputs it needs are the path to a checkout of that repository and its runtime
dependencies (bleak, bleak-retry-connector, pycryptodome). Run from anywhere:

    python generate_reference_fixtures.py <path-to-ha_tuya_ble-checkout>
"""

from __future__ import annotations

import pathlib
import secrets
import shutil
import sys
import tempfile

FIXED_IV = bytes(range(16))
LOCAL_KEY = "0123456789abcdef"
SEC_KEY = "fedcba9876543210"
SEQ = 7
PROTOCOL_VERSION = 3


def load_reference_package(repo_root: pathlib.Path) -> None:
    """Copy the vendored protocol package into a standalone package we can import.

    `custom_components/tuya_ble/__init__.py` is the Home Assistant integration entry
    and pulls in homeassistant, which we don't want; the protocol package itself only
    needs the sibling `const.py` its `..const` import points at.
    """
    src = repo_root / "custom_components" / "tuya_ble"
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="tuya_ref_"))
    pkg = tmp / "tuya_ble_ref"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    shutil.copy(src / "const.py", pkg / "const.py")
    shutil.copytree(src / "tuya_ble", pkg / "tuya_ble")
    # const.py imports tuya_iot for its cloud-endpoint enum, which we never touch —
    # a stub keeps the reference importable without the full Tuya cloud SDK.
    (tmp / "tuya_iot.py").write_text(
        "class TuyaCloudOpenAPIEndpoint:\n"
        "    CHINA = 'https://openapi.tuyacn.com'\n"
        "    AMERICA = 'https://openapi.tuyaus.com'\n"
        "    EUROPE = 'https://openapi.tuyaeu.com'\n"
        "    INDIA = 'https://openapi.tuyain.com'\n"
    )
    sys.path.insert(0, str(tmp))



def kotlin_byte_array(data: bytes) -> str:
    return "byteArrayOf(" + ", ".join(f"0x{b:02x}" for b in data) + ")"


def main() -> None:
    load_reference_package(pathlib.Path(sys.argv[1]))

    from tuya_ble_ref.tuya_ble.const import TuyaBLECode
    from tuya_ble_ref.tuya_ble.security import TuyaBLESecurityMaterial
    from tuya_ble_ref.tuya_ble.tuya_ble import TuyaBLEDevice

    def device(with_sec_key: bool) -> TuyaBLEDevice:
        dev = TuyaBLEDevice(None, None)
        dev._security_material = TuyaBLESecurityMaterial(
            LOCAL_KEY, SEC_KEY if with_sec_key else None
        )
        dev._login_key = dev._security_material.login_key
        dev._protocol_version = PROTOCOL_VERSION
        return dev

    original_token_bytes = secrets.token_bytes
    secrets.token_bytes = lambda n: FIXED_IV[:n]

    try:
        # 1. Device-info requests (empty payload, login key, login flag, protocol 3),
        # once per derivation variant so both security-flag bytes are cross-checked.
        info_v3 = device(False)._build_packets(
            SEQ, TuyaBLECode.FUN_SENDER_DEVICE_INFO, bytes(0), 0
        )
        info_v2 = device(True)._build_packets(
            SEQ, TuyaBLECode.FUN_SENDER_DEVICE_INFO, bytes(0), 0
        )
        # 2. Device-status query (empty payload, session key, session flag), both variants.
        status_v3 = device(False)
        status_v3._session_key = status_v3._security_material.session_key(
            bytes(range(6))
        )
        status_packets_v3 = status_v3._build_packets(
            SEQ, TuyaBLECode.FUN_SENDER_DEVICE_STATUS, bytes(0), 0
        )
        status_v2 = device(True)
        status_v2._session_key = status_v2._security_material.session_key(
            bytes(range(6))
        )
        status_packets_v2 = status_v2._build_packets(
            SEQ, TuyaBLECode.FUN_SENDER_DEVICE_STATUS, bytes(0), 0
        )
        # 3. A datapoint-bearing frame (status query carrying one bool dp 3 = true),
        # to exercise non-empty payloads end to end.
        dev2 = device(False)
        dev2._session_key = dev2._security_material.session_key(bytes(range(6)))
        dp_packets = dev2._build_packets(
            SEQ, TuyaBLECode.FUN_SENDER_DPS, bytes([3, 1, 1, 1]), 0
        )
    finally:
        secrets.token_bytes = original_token_bytes

    material = TuyaBLESecurityMaterial(LOCAL_KEY, SEC_KEY)
    v3_material = TuyaBLESecurityMaterial(LOCAL_KEY, None)

    print(f"loginKey v2   = {material.login_key.hex()}")
    print(f"sessionKey v2 = {material.session_key(bytes(range(6))).hex()}")
    print(f"loginKey v3   = {v3_material.login_key.hex()}")
    print(f"sessionKey v3 = {v3_material.session_key(bytes(range(6))).hex()}")
    print(f"crc16('123456789') = 0x{TuyaBLEDevice._calc_crc16(b'123456789'):04X}")
    print(f"crc16(header)      = 0x{TuyaBLEDevice._calc_crc16(bytes(range(12))):04X}")
    print()
    for name, packets in (
        ("DEVICE_INFO_V3", info_v3),
        ("DEVICE_INFO_V2", info_v2),
        ("DEVICE_STATUS_V3", status_packets_v3),
        ("DEVICE_STATUS_V2", status_packets_v2),
        ("SEND_DPS", dp_packets),
    ):
        print(f"{name}: {len(packets)} fragment(s)")
        for i, packet in enumerate(packets):
            print(f"  fragment {i}: {kotlin_byte_array(packet)}")
        print()


if __name__ == "__main__":
    main()
