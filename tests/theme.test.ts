import { describe, test, expect } from "bun:test";
import { nickColor, getPrefix } from "../src/client/theme.ts";

describe("theme", () => {
  test("nickColor is deterministic", () => {
    const c1 = nickColor("alice");
    const c2 = nickColor("alice");
    // Same nick always produces same color function
    expect(c1("test")).toBe(c2("test"));
  });

  test("different nicks produce color functions without throwing", () => {
    for (const nick of ["alice", "bob", "charlie", "dave", "eve", "frank"]) {
      const fn = nickColor(nick);
      expect(typeof fn).toBe("function");
      expect(typeof fn("X")).toBe("string");
    }
  });

  test("getPrefix returns correct prefixes", () => {
    const join = getPrefix("join");
    expect(join).not.toBeNull();
    expect(join!.text).toBe("-->");

    const part = getPrefix("part");
    expect(part!.text).toBe("<--");

    const error = getPrefix("error");
    expect(error!.text).toBe("=!=");

    const network = getPrefix("network");
    expect(network!.text).toBe(" --");

    const action = getPrefix("action");
    expect(action!.text).toBe("  *");
  });

  test("getPrefix returns null for chat type", () => {
    expect(getPrefix("chat")).toBeNull();
  });
});
