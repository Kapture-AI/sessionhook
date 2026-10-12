import { test } from "node:test";
import assert from "node:assert/strict";
import type { IntakeFilters } from "./config.js";
import type { NewEvent } from "./event.js";
import { droppingRule } from "./filters.js";

const open: IntakeFilters = { allowActors: [], ignoreActors: [], ignoreMarker: "" };

const event: NewEvent = {
  id: "deploys:1",
  topic: "deploys:org/web",
  type: "comment",
  actor: { id: "712", name: "Ada Lovelace" },
  at: "2026-10-12T10:00:00.000Z",
  url: "",
  summary: "Looks good [agent] to me",
};

test("with no rules every event passes", () => {
  assert.equal(droppingRule(event, open), undefined);
});

test("a non-empty allowActors list admits only the listed actor id or name", () => {
  assert.equal(droppingRule(event, { ...open, allowActors: ["712"] }), undefined);
  assert.equal(droppingRule(event, { ...open, allowActors: ["Ada Lovelace"] }), undefined);
  assert.equal(droppingRule(event, { ...open, allowActors: ["Grace Hopper"] }), "allowActors");
});

test("ignoreActors drops an event whose actor id or name is listed", () => {
  assert.equal(droppingRule(event, { ...open, ignoreActors: ["712"] }), "ignoreActors");
  assert.equal(droppingRule(event, { ...open, ignoreActors: ["Ada Lovelace"] }), "ignoreActors");
  assert.equal(droppingRule(event, { ...open, ignoreActors: ["Grace Hopper"] }), undefined);
});

test("ignoreMarker drops an event whose summary contains it", () => {
  assert.equal(droppingRule(event, { ...open, ignoreMarker: "[agent]" }), "ignoreMarker");
  assert.equal(droppingRule(event, { ...open, ignoreMarker: "[other]" }), undefined);
});

test("an event on the allow list is still dropped by the ignore list", () => {
  const filters = { ...open, allowActors: ["Ada Lovelace"], ignoreActors: ["712"] };
  assert.equal(droppingRule(event, filters), "ignoreActors");
});
