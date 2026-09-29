import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { deriveStockStatus } from "../src/modules/products/status";

describe("deriveStockStatus", () => {
  it("returns OUT when quantity is zero", () => {
    expect(deriveStockStatus(0, 0)).toBe("OUT");
    expect(deriveStockStatus("0", "10")).toBe("OUT");
  });

  it("returns LOW when 0 < quantity <= threshold", () => {
    expect(deriveStockStatus(5, 10)).toBe("LOW");
    expect(deriveStockStatus(10, 10)).toBe("LOW"); // boundary: equal counts as low
    expect(deriveStockStatus("0.500", "1")).toBe("LOW");
  });

  it("returns IN_STOCK when quantity exceeds the threshold", () => {
    expect(deriveStockStatus(11, 10)).toBe("IN_STOCK");
    expect(deriveStockStatus(1, 0)).toBe("IN_STOCK"); // zero threshold: any stock is in-stock
  });

  it("is decimal-exact (no float rounding)", () => {
    expect(deriveStockStatus(new Prisma.Decimal("0.001"), new Prisma.Decimal("0.001"))).toBe("LOW");
    expect(deriveStockStatus(new Prisma.Decimal("0.002"), new Prisma.Decimal("0.001"))).toBe(
      "IN_STOCK",
    );
  });
});
