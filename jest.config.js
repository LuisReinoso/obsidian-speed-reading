/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/*.test.ts"],
  // The plugin's production code imports from "obsidian", which doesn't exist
  // in Node. Tests only cover the pure logic in rsvp-layout.ts (no Obsidian
  // imports), so we don't need a mock — just keep testMatch narrow.
};
