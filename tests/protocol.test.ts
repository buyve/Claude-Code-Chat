import { describe, test, expect } from "bun:test";
import { encodeMessage, decodeMessage } from "../src/shared/protocol.ts";
import type { ClientMessage, ServerMessage, WSMessage } from "../src/shared/protocol.ts";

describe("protocol", () => {
  test("encodeMessage + decodeMessage roundtrip (client)", () => {
    const msg: ClientMessage = { type: "chat", channel: "#general", content: "hello" };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  test("encodeMessage + decodeMessage roundtrip (server)", () => {
    const msg: ServerMessage = {
      type: "chat",
      message: {
        id: "abc", from: "user1", fromNick: "alice",
        channel: "#general", content: "hi", timestamp: 1234, type: "chat",
      },
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  test("decodeMessage returns null for invalid JSON", () => {
    expect(decodeMessage("not json")).toBeNull();
    expect(decodeMessage("{broken")).toBeNull();
    expect(decodeMessage("")).toBeNull();
  });

  test("encodeMessage produces valid JSON string", () => {
    const msg: ClientMessage = { type: "join", channel: "#dev" };
    const encoded = encodeMessage(msg);
    expect(typeof encoded).toBe("string");
    expect(() => JSON.parse(encoded)).not.toThrow();
  });

  test("handles unicode content", () => {
    const msg: ClientMessage = { type: "chat", channel: "#general", content: "한글 테스트 🎮" };
    const decoded = decodeMessage(encodeMessage(msg));
    expect((decoded as ClientMessage & { type: "chat" }).content).toBe("한글 테스트 🎮");
  });
});
