import { useState, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "radix-ui";
import { Info } from "lucide-react";

/** Share hover timing across the workspace's contextual hints. */
export function HintProvider({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delayDuration={350}>{children}</Tooltip.Provider>;
}

/** Explain a control on hover or keyboard focus without adding layout space. */
export function Hint({
  children,
  content,
  side = "top",
}: {
  children: ReactElement;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="workspace-hint"
          side={side}
          sideOffset={8}
          collisionPadding={12}
        >
          {content}
          <Tooltip.Arrow className="hint-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Offer longer help on hover, focus, or a tap, with Escape to dismiss. */
export function HelpHint({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="help-hint"
          aria-label={label}
          onClick={() => setOpen((value) => !value)}
        >
          <Info size={14} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="workspace-hint"
          sideOffset={8}
          collisionPadding={12}
        >
          {children}
          <Tooltip.Arrow className="hint-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
