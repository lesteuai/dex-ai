import { describe, expect, it } from "vitest";
import { assessAutonomy, platformOf, roleTypeOf } from "./autonomy";

const target = { platform: "jobs.example", roleType: "senior frontend engineer" };

function times(count: number, item: { platform: string; roleType: string | null }) {
  return Array.from({ length: count }, () => item);
}

describe("autonomy familiarity gate", () => {
  it("is autonomous once platform and role type each reach the threshold", () => {
    const result = assessAutonomy(target, times(3, target), 3);

    expect(result).toMatchObject({ autonomous: true, platformCount: 3, roleCount: 3 });
  });

  it("asks first on a new platform even when the role type is familiar", () => {
    const elsewhere = { platform: "other.example", roleType: target.roleType };
    const result = assessAutonomy(target, times(5, elsewhere), 3);

    expect(result.autonomous).toBe(false);
    expect(result.reason).toMatch(/New platform: 0 of 3/);
  });

  it("asks first on a new role type even when the platform is familiar", () => {
    const otherRole = { platform: target.platform, roleType: "data analyst" };
    const result = assessAutonomy(target, times(3, otherRole), 3);

    expect(result.autonomous).toBe(false);
    expect(result.reason).toMatch(/New role type: 0 of 3/);
  });

  it("treats a new company as the same role type and the url host as the platform", () => {
    expect(roleTypeOf("Senior Frontend Engineer at Acme")).toBe("senior frontend engineer");
    expect(roleTypeOf("Senior  Frontend Engineer - Globex")).toBe("senior frontend engineer");
    expect(roleTypeOf(undefined)).toBeNull();
    expect(platformOf("https://Jobs.Example/listings/42")).toBe("jobs.example");
  });
});
