import { describe, expect, it } from "vitest";
import { parseDotenv, parseImportContents, parseJsonSecrets } from "../src/dotenv.js";
import { AppError } from "../src/errors.js";

describe("dotenv parser", () => {
  it("handles comments, exports, quotes, escapes, and duplicates", () => {
    const entries = parseDotenv(
      [
        "# a comment",
        "",
        "FOO=bar",
        'export QUOTED="a b"',
        'NEWLINE="line1\\nline2"',
        'TAB="a\\tb"',
        "SINGLE='x#y'",
        "EMPTY=",
        "DUP=1",
        "DUP=2",
      ].join("\n"),
    );

    expect(Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))).toEqual({
      FOO: "bar",
      QUOTED: "a b",
      NEWLINE: "line1\nline2",
      TAB: "a\tb",
      SINGLE: "x#y",
      EMPTY: "",
      DUP: "2",
    });
  });

  it("handles CRLF and a BOM", () => {
    const entries = parseDotenv("\uFEFFA=1\r\nB=2\r\n");
    expect(entries).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
  });

  it("rejects malformed lines and keys", () => {
    expect(() => parseDotenv("NOT A LINE")).toThrow(AppError);
    expect(() => parseDotenv("1BAD=x")).toThrow(AppError);
    expect(() => parseDotenv("BAD-KEY=x")).toThrow(AppError);
  });
});

describe("json parser", () => {
  it("accepts scalar values only", () => {
    expect(parseJsonSecrets('{"A":"x","B":2,"C":true,"D":null}')).toEqual([
      { key: "A", value: "x" },
      { key: "B", value: "2" },
      { key: "C", value: "true" },
      { key: "D", value: "" },
    ]);
    expect(() => parseJsonSecrets('{"A":{"nested":true}}')).toThrow(AppError);
    expect(() => parseJsonSecrets("[1,2]")).toThrow(AppError);
    expect(() => parseJsonSecrets("not json")).toThrow(AppError);
  });
});

describe("import contents", () => {
  it("refuses empty imports", () => {
    expect(() => parseImportContents("# only comments\n", "env")).toThrow(AppError);
  });

  it("refuses more than 200 keys", () => {
    const contents = Array.from({ length: 201 }, (_, index) => `KEY_${index}=x`).join("\n");
    expect(() => parseImportContents(contents, "env")).toThrow(AppError);
  });
});
