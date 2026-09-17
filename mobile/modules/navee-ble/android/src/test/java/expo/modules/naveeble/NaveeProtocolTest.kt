package expo.modules.naveeble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

private fun hex(s: String): ByteArray = s.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

/**
 * A scooter → app frame built independently of NaveeFrame, so the parser isn't tested
 * against itself. The scooter sums from the `AA` rather than the `55` — see the captured
 * replies in [NaveeCapturedFrameTest], which is why this drops the header byte.
 */
private fun response(cmd: Int, status: Int, data: ByteArray): ByteArray {
  val body = byteArrayOf(0x55, 0xAA.toByte(), 0, cmd.toByte(), (data.size + 1).toByte(), status.toByte()) + data
  val sum = body.drop(1).sumOf { it.toInt() and 0xFF } and 0xFF
  return body + byteArrayOf(sum.toByte(), 0xFE.toByte(), 0xFD.toByte())
}

class NaveeFrameTest {
  @Test
  fun `read command has no length byte`() {
    // 55+AA+00+70 = 0x16F → checksum 0x6F, as the official app's j(112) builds it.
    assertArrayEquals(hex("55aa00706ffefd"), NaveeFrame.read(0x70))
  }

  @Test
  fun `write command carries its length`() {
    // k(81, 1): 55 aa 00 51 01 01, sum = 0x152 → 52.
    assertArrayEquals(hex("55aa0051010152fefd"), NaveeFrame.write(0x51, byteArrayOf(1)))
  }

  @Test
  fun `clock payload is sub-command 6 then big-endian seconds`() {
    val frame = NaveeFrame.setClock(0x01020304)
    assertArrayEquals(hex("0601020304"), frame.copyOfRange(5, 10))
  }

  @Test
  fun `parses a response and splits the status byte off`() {
    val parsed = NaveeFrame.parse(response(0x90, 0, hex("0003510000005a01")))!!
    assertEquals(0x90, parsed.cmd)
    assertEquals(0, parsed.status)
    assertArrayEquals(hex("0003510000005a01"), parsed.data)
  }

  @Test
  fun `rejects a bad checksum`() {
    val frame = response(0x90, 0, hex("00035100"))
    frame[frame.size - 3] = (frame[frame.size - 3] + 1).toByte()
    assertNull(NaveeFrame.parse(frame))
  }

  @Test
  fun `reassembles a frame split across notifications and skips noise`() {
    val frame = response(0x92, 0, ByteArray(18) { it.toByte() })
    val r = NaveeFrame.Reassembler()
    val first = r.accept(byteArrayOf(0x01, 0x02) + frame.copyOfRange(0, 10))
    assertTrue(first.frames.isEmpty())
    assertEquals(2, first.discarded)
    val second = r.accept(frame.copyOfRange(10, frame.size) + response(0x90, 0, hex("00")))
    assertEquals(listOf(0x92, 0x90), second.frames.map { it.cmd })
  }

  @Test
  fun `a header split between chunks survives`() {
    val frame = response(0x30, 0, ByteArray(0))
    val r = NaveeFrame.Reassembler()
    assertTrue(r.accept(frame.copyOfRange(0, 1)).frames.isEmpty())
    assertEquals(1, r.accept(frame.copyOfRange(1, frame.size)).frames.size)
  }
}

class NaveeAuthTest {
  private val key1 = hex("446d10726dbe05f662dfaaf01327303f")

  @Test
  fun `account id becomes the six id bytes the official app sends`() {
    // f.m(12345, 0x88): top byte forced to 0x88.
    assertArrayEquals(hex("880000003039"), NaveeAuth.idBytes(12345))
  }

  @Test
  fun `auth request matches the official layout`() {
    val frame = NaveeAuth.authRequest(12345, 0, 1)
    // 55 aa 00 30 09 | 01 00 | 88 00 00 00 30 39 | 00
    assertArrayEquals(hex("55aa003009010088000000303900"), frame.copyOfRange(0, 14))
    assertEquals(frame.copyOfRange(0, 14).sumOf { it.toInt() and 0xFF } and 0xFF, frame[14].toInt() and 0xFF)
  }

  @Test
  fun `empty ok reply means authenticated`() {
    assertTrue(NaveeAuth.onAuthReply(NaveeFrame.parse(response(0x30, 0, ByteArray(0)))!!, 1) is NaveeAuth.Reply.Authenticated)
  }

  @Test
  fun `non-zero status is a rejection`() {
    val reply = NaveeAuth.onAuthReply(NaveeFrame.parse(response(0x30, 2, ByteArray(0)))!!, 1)
    assertEquals(2, (reply as NaveeAuth.Reply.Rejected).status)
  }

  @Test
  fun `a 16-byte challenge is answered AES-encrypted under the named key`() {
    val challenge = ByteArray(16) { (it * 7).toByte() }
    val reply = NaveeAuth.onAuthReply(NaveeFrame.parse(response(0x30, 0, challenge))!!, 1) as NaveeAuth.Reply.Challenge
    assertEquals(0x31, reply.answer[3].toInt())
    val encrypted = reply.answer.copyOfRange(5, 21)
    val cipher = Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.DECRYPT_MODE, SecretKeySpec(key1, "AES")) }
    assertArrayEquals(challenge, cipher.doFinal(encrypted))
  }

  @Test
  fun `mode-prefixed challenge with mode 0 is XORed`() {
    val body = ByteArray(16) { it.toByte() }
    val reply = NaveeAuth.onAuthReply(NaveeFrame.parse(response(0x30, 0, byteArrayOf(0) + body))!!, 1) as NaveeAuth.Reply.Challenge
    val answer = reply.answer.copyOfRange(5, 21)
    assertArrayEquals(ByteArray(16) { (body[it].toInt() xor key1[it].toInt()).toByte() }, answer)
  }
}

class NaveeTelemetryTest {
  @Test
  fun `home telemetry maps battery, drive mode, lock and voltage`() {
    // warning 0, mode 2 (drive), battery 81%, status, charging 0, pushWarn, 23 km left,
    // lock 1 (= unlocked), then 42000 mV LE and 4 bytes of current.
    val dps = NaveeTelemetry.home(hex("0002510000001701" + "10a40000" + "00000000"))!!
    assertEquals(81, dps["3"])
    assertEquals("level_2", dps["14"])
    assertEquals(2, dps["rideMode"])
    assertEquals(true, dps["1"])
    assertEquals(420, dps["20"])
    assertEquals(23, dps["navee.remainingKm"])
  }

  @Test
  fun `unknown driving mode is not guessed`() {
    // 5 is the "turbo" the decompiled sources describe; this model has no such mode.
    val dps = NaveeTelemetry.home(hex("0005510000001700"))!!
    assertNull(dps["14"])
    assertEquals(5, dps["navee.drivingMode"])
    assertEquals(5, dps["rideMode"])
  }

  @Test
  fun `walking mode is reported raw but is not a riding level`() {
    val dps = NaveeTelemetry.home(hex("000b510000001700"))!!
    assertNull(dps["14"])
    assertEquals(11, dps["navee.drivingMode"])
    assertEquals(11, dps["rideMode"])
  }

  @Test
  fun `switching to walking clears the stale eco or ride dp14, not just leaves it unset`() {
    // A live-push map is merged key-by-key into the session's cached dps (see
    // deviceLink/session.ts): a key genuinely absent from this map leaves whatever was
    // cached before untouched, which is exactly the bug — the last Eco/Ride reading
    // survived a switch to walking. dp14 has to be present with an explicit null so the
    // merge actually overwrites it.
    val ridingDps = NaveeTelemetry.home(hex("0002510000001701" + "10a40000" + "00000000"))!!
    assertEquals("level_2", ridingDps["14"])
    val walkingDps = NaveeTelemetry.home(hex("000b510000001700"))!!
    assertTrue(walkingDps.containsKey("14"))
    assertNull(walkingDps["14"])
  }

  @Test
  fun `drive telemetry v1 reads the wide fields`() {
    val d = hex("50" + "01" + "fa00" + "17" + "2c01" + "0c" + "0000" + "0000" + "0100" + "e8030000")
    val dps = NaveeTelemetry.driveV1(d)!!
    assertEquals(80, dps["3"])
    assertEquals(250, dps["2"])
    assertEquals(300, dps["5"])
    assertEquals(720, dps["6"])
    assertEquals(1000, dps["12"]) // u32 override (100.0 km) wins over the u16 field
  }

  @Test
  fun `settings read exposes every settings field`() {
    val d = ByteArray(39)
    d[1] = 3 // eco
    d[2] = 1 // locked
    d[20] = (0x80 or 25).toByte()
    d[25] = 32
    val dps = NaveeTelemetry.status(d)!!
    assertEquals("level_1", dps["14"])
    assertEquals(false, dps["1"])
    assertEquals(0x80 or 25, dps["speedLimit"])
    assertEquals(32, dps["maxSpeed"])
    assertEquals(3, dps["rideMode"])
  }

  @Test
  fun `setting writes use the official commands`() {
    assertArrayEquals(NaveeFrame.write(0x58, byteArrayOf(5)), NaveeSettings.field("rideMode")!!.encode(5))
    assertArrayEquals(NaveeFrame.write(0x6E, byteArrayOf(1, 32)), NaveeSettings.field("maxSpeed")!!.encode(32))
    assertEquals(0x6B, NaveeSettings.ackCommand("speedLimit"))
  }
}

class NaveeAdvertisementTest {
  @Test
  fun `product id and cloud mac come from the raw record the official way`() {
    val record = hex("0bff01f10000" + "e45a" + "665544332211" + "0000")
    assertEquals(0x5AE4, NaveeAdvertisement.productId(record))
    assertEquals("112233445566", NaveeAdvertisement.cloudMac(record))
  }

  @Test
  fun `mac normalisation round-trips`() {
    assertEquals("AABBCCDDEEFF", NaveeAdvertisement.normalizeMac("aa:bb:cc:dd:ee:ff"))
    assertEquals("AA:BB:CC:DD:EE:FF", NaveeAdvertisement.toBluetoothAddress("aabbccddeeff"))
  }
}

class NaveeCloudParseTest {
  @Test
  fun `vehicle list keeps the fields pairing needs`() {
    val body = """{"code":200,"msg":"ok","data":[{"mac":"aa:bb:cc:dd:ee:ff","vehicleName":"","carNo":"N1234567IT0000000","shareUserId":0,
      "model":{"pid":"2328","name":"V40i Pro"}},{"mac":""}]}"""
    val vehicles = NaveeCloudResponses.parseVehicles(NaveeCloudResponses.unwrap(body))
    assertEquals(1, vehicles.size)
    assertEquals("AABBCCDDEEFF", vehicles[0].mac)
    assertEquals("V40i Pro", vehicles[0].name)
    assertEquals("2328", vehicles[0].productId)
  }

  @Test(expected = NaveeCloudException::class)
  fun `non-200 code throws`() {
    NaveeCloudResponses.unwrap("""{"code":500,"msg":"wrong code"}""")
  }
}

/**
 * Frames captured off the air between the official app and a real V40i Pro (HCI snoop).
 * These are the ground truth the rest of the protocol is checked against: the decompiled
 * sources describe some version of the app, while these are what this scooter accepts and
 * sends today.
 */
class NaveeCapturedFrameTest {
  @Test
  fun `the auth frame the scooter accepts is the one we build`() {
    // Observed: app → scooter, answered with status 0.
    assertArrayEquals(hex("55aa00300900008800001417c100acfefd"), NaveeAuth.authRequest(1316801, 0, 0))
  }

  @Test
  fun `captured auth replies parse and carry their status`() {
    // Both sum from the AA, so the app's own checksum rule rejects them outright.
    val ok = NaveeFrame.parse(hex("55aa00300100dbfefd"))
    assertEquals(0, ok!!.status)
    assertEquals(NaveeFrame.CMD_AUTH, ok.cmd)

    val refused = NaveeFrame.parse(hex("55aa00300102ddfefd"))
    assertEquals(NaveeAuth.STATUS_UNKNOWN_ID, refused!!.status)
  }

  @Test
  fun `captured status and telemetry pushes parse`() {
    assertEquals(NaveeFrame.CMD_READ_STATUS, NaveeFrame.parse(hex("55aa00700b0001030000005a0001010085fefd"))!!.cmd)
    assertEquals(NaveeFrame.CMD_HOME_TELEMETRY, NaveeFrame.parse(hex("55aa009008000003210000000d73fefd"))!!.cmd)
    assertEquals(
      NaveeFrame.CMD_DRIVE_TELEMETRY_V1,
      NaveeFrame.parse(hex("55aa00920f00210000000d00000000000000f80d7efefd"))!!.cmd,
    )
  }

  @Test
  fun `a frame whose checksum matches neither rule is still rejected`() {
    assertNull(NaveeFrame.parse(hex("55aa00300100fffefd")))
  }
}

class NaveeShortPayloadTest {
  @Test
  fun `the home push this scooter actually sends is decoded, not dropped`() {
    // 55aa009008 00 0003210000000d 73 fefd, captured: seven bytes, no voltage field.
    val dps = NaveeTelemetry.home(hex("0003210000000d"))!!
    assertEquals(33, dps["3"])
    assertEquals(13, dps["navee.remainingKm"])
    assertEquals(false, dps["navee.charging"])
    assertNull(dps["20"]) // no voltage in a payload this short
    assertNull(dps["1"]) // lock byte absent rather than guessed
  }
}

class NaveeOdometerScaleTest {
  @Test
  fun `the odometer matches what the scooter's own app shows`() {
    // Captured drive push; the scooter's app reports 357.6 km for this exact frame, and
    // dp12 is tenths of a km, so the raw value passes through unscaled.
    val frame = NaveeFrame.parse(hex("55aa00920f001e0000000c00000000000000f80d7afefd"))!!
    assertEquals(3576, NaveeTelemetry.toDps(frame)!!["12"])
  }
}

class NaveeBatteryReadTest {
  @Test
  fun `the battery read is the only source of pack voltage`() {
    // Captured 0x72 reply: 30% and 36100 mV, taken while the pushes reported the same 30%.
    val dps = NaveeTelemetry.battery(hex("001e048d000064000000001c000000"))!!
    assertEquals(30, dps["3"])
    assertEquals(361, dps["20"]) // dp20 is volts x10
  }

  @Test
  fun `a truncated battery reply reports nothing rather than a zero voltage`() {
    assertNull(NaveeTelemetry.battery(hex("001e")))
  }
}
