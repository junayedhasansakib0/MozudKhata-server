import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors";
import { nextBalanceOrThrow, signedDelta } from "../src/modules/stock/math";

const d = (v: number | string) => new Prisma.Decimal(v);

describe("signedDelta", () => {
  it("adds stock for IN", () => {
    expect(signedDelta("IN", d(10)).toString()).toBe("10");
  });

  it("subtracts stock for OUT and DAMAGED_LOST", () => {
    expect(signedDelta("OUT", d(10)).toString()).toBe("-10");
    expect(signedDelta("DAMAGED_LOST", d(3.5)).toString()).toBe("-3.5");
  });

  it("keeps the sign for ADJUSTMENT (either direction)", () => {
    expect(signedDelta("ADJUSTMENT", d(-4)).toString()).toBe("-4");
    expect(signedDelta("ADJUSTMENT", d(7)).toString()).toBe("7");
  });

  it("rejects non-positive magnitude for IN/OUT/DAMAGED_LOST", () => {
    expect(() => signedDelta("IN", d(0))).toThrow(AppError);
    expect(() => signedDelta("OUT", d(-1))).toThrow(AppError);
    expect(() => signedDelta("DAMAGED_LOST", d(0))).toThrow(AppError);
  });

  it("rejects a zero ADJUSTMENT", () => {
    expect(() => signedDelta("ADJUSTMENT", d(0))).toThrow(AppError);
  });
});

describe("nextBalanceOrThrow", () => {
  it("returns the summed balance when non-negative", () => {
    expect(nextBalanceOrThrow(d(10), d(5)).toString()).toBe("15");
    expect(nextBalanceOrThrow(d(10), d(-10)).toString()).toBe("0");
    expect(nextBalanceOrThrow(d("2.500"), d("0.250")).toString()).toBe("2.75");
  });

  it("throws CONFLICT when the balance would go negative", () => {
    expect(() => nextBalanceOrThrow(d(10), d(-11))).toThrow(AppError);
    try {
      nextBalanceOrThrow(d(0), d(-1));
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFLICT");
    }
  });
});
