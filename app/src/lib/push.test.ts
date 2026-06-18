import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array } from "./push";

describe("push — urlBase64ToUint8Array (VAPID key conversion)", () => {
  it("decodes a url-safe base64 string (- _) into the expected bytes", () => {
    // 0xfb 0xff 0xbf → standard base64 "+/+/", url-safe "-_-_".
    const out = urlBase64ToUint8Array("-_-_");
    expect(Array.from(out)).toEqual([0xfb, 0xff, 0xbf]);
  });

  it("pads an unpadded url-safe string to a valid length", () => {
    // "TQ" → padded "TQ==" → 0x4d ('M').
    const out = urlBase64ToUint8Array("TQ");
    expect(Array.from(out)).toEqual([0x4d]);
  });

  it("decodes the production VAPID public key to a 65-byte P-256 point", () => {
    const key =
      "BOzlwBTRyg5_Ip2BKnrdh6BSmDPijVkyoUTSzR-855XqkHVmezMyQNfNKKxztqo5PDTv_BJjDsMH5-o_R3YMjW0";
    const out = urlBase64ToUint8Array(key);
    // Uncompressed EC point: 0x04 prefix + 32-byte X + 32-byte Y = 65 bytes.
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x04);
  });
});
