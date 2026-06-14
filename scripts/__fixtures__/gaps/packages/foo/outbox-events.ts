// FIXTURE — intentional violation: event name lacks the mN. module prefix.
// Proves check-fitness-gaps.ts goes RED (event-naming).
export function emit() {
  publish("notamodule.thing.created");
}
declare function publish(name: string): void;
