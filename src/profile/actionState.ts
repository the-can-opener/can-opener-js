/**
 * Present-tense action commands whose recorded vehicle state is a different
 * word. `open`, `on`, `off`, and level names already name the condition.
 */
const ACTION_COMMAND_STATE: Readonly<Record<string, string>> = {
  lock: "locked",
  unlock: "unlocked",
  close: "closed",
  fold: "folded",
  unfold: "unfolded",
};

/**
 * Condition written to vehicle state after an action command reaches the bus.
 * `lock` records `locked`; a command that already names the condition is unchanged.
 */
export function recordedActionState(command: string): string {
  return ACTION_COMMAND_STATE[command] ?? command;
}
