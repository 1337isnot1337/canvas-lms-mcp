import { describe, expect, it } from "vitest";
import { getNextLink } from "../src/canvas/pagination";

describe("Canvas pagination", () => {
  it("extracts the rel=next URL from Canvas Link headers", () => {
    const link = [
      '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next"',
      '<https://canvas.example.edu/api/v1/courses?page=1>; rel="current"',
      '<https://canvas.example.edu/api/v1/courses?page=4>; rel="last"',
    ].join(", ");

    expect(getNextLink(link)).toBe("https://canvas.example.edu/api/v1/courses?page=2");
    expect(getNextLink(null)).toBeNull();
  });
});
