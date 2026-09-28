import type { InputRenderable, KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { approvalChoices, approvalRows } from "./approval-panel";
import type { UiApproval, UiDecision } from "./types";

/**
 * How long an approval is on screen before its keys answer it: keys typed ahead for the
 * composer must not approve something the user hasn't seen.
 */
export const APPROVAL_ARM_MS = 300;

const isEnter = (key: KeyEvent) =>
  key.name === "return" || key.name === "linefeed" || key.name === "kpenter";

/**
 * The approval panel's state and keys: the open request, the highlighted choice, the diff's
 * scroll position, and the optional note after "no". While it's open the composer is blurred;
 * during a note it takes the note, and the draft it held comes back however the panel closes.
 */
export const useApproval = ({
  input,
  setDraft,
  answer,
}: {
  readonly input: RefObject<InputRenderable | null>;
  readonly setDraft: (text: string) => void;
  readonly answer: (id: string, decision: UiDecision) => void;
}) => {
  const [approval, setApproval] = useState<UiApproval | undefined>(undefined);
  const shownAt = useRef(0);
  // Mirrored in a ref: a key handled before React re-renders must see the latest choice.
  const [choice, setChoiceState] = useState(0);
  const choiceRef = useRef(0);
  const setChoice = useCallback((index: number) => {
    choiceRef.current = index;
    setChoiceState(index);
  }, []);
  const [offset, setOffset] = useState(0);
  // Also mirrored: a pasted `n` then Enter arrive before React re-renders, and that Enter must
  // send the note, not pick Allow.
  const [noting, setNotingState] = useState(false);
  const notingRef = useRef(false);
  const setNoting = useCallback((value: boolean) => {
    notingRef.current = value;
    setNotingState(value);
  }, []);
  const draftBeforeNote = useRef("");
  const { width, height } = useTerminalDimensions();

  // However the approval closes (answered, cancelled, the turn ended), the note is over and
  // the draft it set aside comes back.
  useEffect(() => {
    if (approval === undefined && noting) {
      setNoting(false);
      setDraft(draftBeforeNote.current);
    }
  }, [approval, noting, setDraft, setNoting]);

  const open = useCallback(
    (request: UiApproval) => {
      // The panel takes Enter and y / a / n; the composer must not (the `focused` prop alone
      // doesn't blur it).
      input.current?.blur();
      shownAt.current = Date.now();
      setOffset(0);
      setChoice(0);
      setApproval(request);
    },
    [input, setChoice],
  );
  const cancel = useCallback(
    (id: string) => setApproval((shown) => (shown?.id === id ? undefined : shown)),
    [],
  );
  const close = useCallback(() => setApproval(undefined), []);

  /** Answers the open approval and gives the composer back (the note's draft returns). */
  const decide = (decision: UiDecision) => {
    if (!approval) return;
    notingRef.current = false;
    setApproval(undefined);
    input.current?.focus();
    answer(approval.id, decision);
  };

  /** Enter in the composer: sends it as the denial's note when one is being written. */
  const submitNote = (text: string) => {
    if (!approval || !notingRef.current) return false;
    decide({ no: text });
    return true;
  };

  /** Esc during a note: back to the choices, with the draft the note set aside. */
  const leaveNote = () => {
    setNoting(false);
    setDraft(draftBeforeNote.current);
    input.current?.blur();
  };

  /** The panel's rows at this terminal size: its head always shows and the body scrolls. */
  const panel = (() => {
    if (!approval) return undefined;
    const { head, body } = approvalRows(approval, width - 2);
    // The rows left after the header, composer, footer, position line, choices (a blank row
    // above them), and three rows of conversation.
    const rows = Math.max(3, height - 11 - head.length);
    const maxOffset = Math.max(0, body.length - rows);
    return {
      head,
      body,
      rows,
      offset: Math.min(offset, maxOffset),
      maxOffset,
      choices: approvalChoices(approval).map((c) => c.label),
    };
  })();

  /** Handles `key` if it's one of the panel's; true when it was. */
  const handleKey = (key: KeyEvent): boolean => {
    if (!approval || !panel) return false;
    const armed = Date.now() - shownAt.current >= APPROVAL_ARM_MS;
    if (!notingRef.current && !key.ctrl && !key.meta) {
      const choices = approvalChoices(approval);
      const arrow = key.name === "left" ? -1 : key.name === "right" ? 1 : 0;
      const picked = isEnter(key)
        ? choices[choiceRef.current]?.decision
        : key.name === "y"
          ? "yes"
          : key.name === "a" && approval.canAlways
            ? "always"
            : key.name === "n"
              ? "no"
              : undefined;
      // The panel's keys are kept from the composer, which regains focus while one is handled,
      // and typed before the panel could be read, they do nothing.
      if (arrow !== 0 || picked !== undefined || isEnter(key) || key.name === "a") {
        key.preventDefault();
        if (!armed) return true;
      }
      if (arrow !== 0) {
        setChoice(Math.max(0, Math.min(choices.length - 1, choiceRef.current + arrow)));
        return true;
      }
      if (picked === "yes" || picked === "always") {
        decide(picked);
        return true;
      }
      if (picked === "no") {
        draftBeforeNote.current = input.current?.value ?? "";
        setDraft("");
        setNoting(true);
        input.current?.focus();
        return true;
      }
    }
    const page = { up: -1, down: 1, pageup: -panel.rows, pagedown: panel.rows }[key.name];
    if (page !== undefined && panel.maxOffset > 0) {
      key.preventDefault();
      const maxOffset = panel.maxOffset;
      setOffset((at) => Math.max(0, Math.min(maxOffset, at + page)));
      return true;
    }
    return false;
  };

  return {
    approval,
    noting,
    choice,
    open,
    cancel,
    close,
    decide,
    leaveNote,
    submitNote,
    panel,
    handleKey,
  };
};
