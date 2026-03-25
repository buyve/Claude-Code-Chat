import { describe, test, expect } from "bun:test";
import { createStore } from "../src/server/store.ts";
import type { Message } from "../src/shared/types.ts";

function makeMsg(channel: string, content: string, offset = 0): Message {
  return {
    id: crypto.randomUUID(),
    from: "user1",
    fromNick: "alice",
    channel,
    content,
    timestamp: Date.now() - offset,
    type: "chat",
  };
}

describe("store", () => {
  test("addMessage + getHistory roundtrip", () => {
    const store = createStore(":memory:");
    const msg = makeMsg("#general", "hello");
    store.addMessage(msg);

    const history = store.getHistory("#general");
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("hello");
    expect(history[0]!.from).toBe("user1");
    store.close();
  });

  test("history returns oldest first, limited", () => {
    const store = createStore(":memory:");
    for (let i = 0; i < 100; i++) {
      store.addMessage(makeMsg("#general", `msg-${i}`, 100 - i));
    }
    const history = store.getHistory("#general", 10);
    expect(history).toHaveLength(10);
    // Should be the last 10 messages (oldest first)
    expect(history[0]!.content).toBe("msg-90");
    expect(history[9]!.content).toBe("msg-99");
    store.close();
  });

  test("nick persistence", () => {
    const store = createStore(":memory:");
    expect(store.getNick("fp1")).toBeNull();

    store.setNick("fp1", "alice");
    expect(store.getNick("fp1")).toBe("alice");

    store.setNick("fp1", "alice2");
    expect(store.getNick("fp1")).toBe("alice2");
    store.close();
  });

  test("nickExists check", () => {
    const store = createStore(":memory:");
    store.setNick("fp1", "alice");
    store.setNick("fp2", "bob");

    expect(store.nickExists("alice")).toBe(true);
    expect(store.nickExists("alice", "fp1")).toBe(false); // exclude self
    expect(store.nickExists("charlie")).toBe(false);
    store.close();
  });
});
