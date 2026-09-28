import { useTimeline } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { printable } from "./printable";
import { theme } from "./theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/** `12s`, then `1m 05s`. */
export const elapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

const tickNow = () => Math.floor(Date.now() / FRAME_MS);

/**
 * The row above the composer while a turn runs and nothing on screen moves: a spinner, what the
 * agent is doing (`Thinking`, or the running tool's line), and how long the turn has taken, so a
 * quiet wait between model steps or a slow command never looks frozen. OpenTUI's timeline is its
 * clock: the engine keeps the renderer live only while it plays.
 */
export const Working = ({
  label,
  startedAt,
}: {
  readonly label: string;
  readonly startedAt: number;
}) => {
  // One state change per spinner frame, not per engine frame: React skips equal ticks.
  const [tick, setTick] = useState(tickNow);
  const timeline = useTimeline({ duration: FRAMES.length * FRAME_MS, loop: true });
  const added = useRef(false);
  useEffect(() => {
    // The timeline animates nothing: its item is only a per-frame callback. The timeline has no
    // way to remove an item, so it's added once (an effect can run twice in StrictMode).
    if (added.current) return;
    added.current = true;
    timeline.add({}, { duration: FRAMES.length * FRAME_MS, onUpdate: () => setTick(tickNow()) });
  }, [timeline]);
  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={1}>
      <text fg={theme.tool} flexShrink={0}>{`${FRAMES[tick % FRAMES.length]} `}</text>
      <text fg={theme.muted} wrapMode="none" flexShrink={1}>
        {printable(label)}
      </text>
      <text fg={theme.faint} flexShrink={0}>
        {` · ${elapsed(Math.max(0, tick * FRAME_MS - startedAt))}`}
      </text>
    </box>
  );
};
