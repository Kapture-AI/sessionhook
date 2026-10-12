import type { IntakeFilters } from "./config.js";
import type { NewEvent } from "./event.js";

// Returns the rule that drops the event, or undefined when it passes.
export function droppingRule(event: NewEvent, filters: IntakeFilters): string | undefined {
  const actors = [event.actor.id, event.actor.name];
  if (filters.allowActors.length > 0 && !actors.some((actor) => filters.allowActors.includes(actor))) {
    return "allowActors";
  }
  if (actors.some((actor) => filters.ignoreActors.includes(actor))) return "ignoreActors";
  if (filters.ignoreMarker !== "" && event.summary.includes(filters.ignoreMarker)) {
    return "ignoreMarker";
  }
  return undefined;
}
