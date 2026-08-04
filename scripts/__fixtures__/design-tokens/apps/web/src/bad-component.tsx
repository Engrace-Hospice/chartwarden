// Planted violation (TASK-050D): a raw hex literal in render code — must flow through a Lantern
// token (var(--color-*) or the `t` map) instead so it stays theme-reactive.
export const BadColor = "#ff00aa";
