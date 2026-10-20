import { describe, expect, it } from "vitest";
import {
  acceptedContainers,
  canShareBottle,
  cleanAlternates,
  parseContainerList,
  sharedContainers,
} from "@/lib/containers";

describe("acceptedContainers", () => {
  it("puts the required container first, then the alternates, upper case and without repeats", () => {
    expect(acceptedContainers("plain", ["gel", "PLAIN", " gel "])).toEqual(["PLAIN", "GEL"]);
  });

  it("is empty (any container) when no container is required, whatever the alternates say", () => {
    expect(acceptedContainers(null, ["GEL"])).toEqual([]);
    expect(acceptedContainers(undefined, undefined)).toEqual([]);
    expect(acceptedContainers("", [])).toEqual([]);
  });
});

describe("cleanAlternates", () => {
  it("drops a repeat of the required type and blanks", () => {
    expect(cleanAlternates("PLAIN", ["PLAIN", "gel", ""])).toEqual(["GEL"]);
  });

  it("keeps nothing when there is no required container", () => {
    expect(cleanAlternates(null, ["GEL"])).toEqual([]);
  });
});

describe("parseContainerList", () => {
  it("splits on commas, semicolons and spaces", () => {
    expect(parseContainerList("gel, edta;  citrate")).toEqual(["GEL", "EDTA", "CITRATE"]);
    expect(parseContainerList("")).toEqual([]);
    expect(parseContainerList(undefined)).toEqual([]);
  });
});

describe("sharedContainers", () => {
  it("is null when no test has a requirement", () => {
    expect(sharedContainers([])).toBeNull();
    expect(sharedContainers([[], []])).toBeNull();
  });

  it("returns what every limited test accepts, ignoring tests that accept anything", () => {
    expect(sharedContainers([["PLAIN", "GEL"]])).toEqual(["PLAIN", "GEL"]);
    expect(sharedContainers([["PLAIN", "GEL"], ["GEL", "PLAIN"]])).toEqual(["PLAIN", "GEL"]);
    expect(sharedContainers([["PLAIN", "GEL"], ["PLAIN"], []])).toEqual(["PLAIN"]);
    expect(sharedContainers([["PLAIN", "GEL"], ["EDTA"]])).toEqual([]);
  });
});

describe("canShareBottle", () => {
  it("lets tests with a container in common share a bottle", () => {
    expect(canShareBottle(["PLAIN", "GEL"], ["GEL"])).toBe(true);
    expect(canShareBottle(["EDTA"], ["EDTA"])).toBe(true);
    expect(canShareBottle(["PLAIN", "GEL"], ["EDTA"])).toBe(false);
  });

  it("groups tests that accept any container only with each other", () => {
    expect(canShareBottle([], [])).toBe(true);
    expect(canShareBottle([], ["EDTA"])).toBe(false);
    expect(canShareBottle(["EDTA"], [])).toBe(false);
  });
});
