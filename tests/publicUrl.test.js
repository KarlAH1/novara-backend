import test from "node:test";
import assert from "node:assert/strict";
import { publicAppUrl } from "../utils/publicUrl.js";

test("links never point at localhost in production, even when it is first in FRONTEND_URL", () => {
  assert.equal(publicAppUrl({ NODE_ENV: "production", FRONTEND_URL: "http://localhost:5500,https://raisium.io/" }), "https://raisium.io");
  assert.equal(publicAppUrl({ NODE_ENV: "production", FRONTEND_URL: "http://localhost:8080" }), "https://raisium.io");
  assert.equal(publicAppUrl({ NODE_ENV: "production", FRONTEND_URL: "" }), "https://raisium.io");
});

test("PUBLIC_APP_URL wins, and local testing keeps its own address", () => {
  assert.equal(publicAppUrl({ NODE_ENV: "production", PUBLIC_APP_URL: "https://app.raisium.io/", FRONTEND_URL: "https://raisium.io" }), "https://app.raisium.io");
  assert.equal(publicAppUrl({ NODE_ENV: "development", FRONTEND_URL: "http://localhost:8080" }), "http://localhost:8080");
});
