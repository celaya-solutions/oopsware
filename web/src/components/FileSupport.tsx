import { ArrowUpRight } from "lucide-react";
import { FILE_SUPPORT } from "../targetSupport";
import { Button } from "./ui/button";
import { HelpHint } from "./Hint";

/** Explain useful file coverage without promising unavailable decompilers. */
export function FileSupport({ explore }: { explore: (query: string) => void }) {
  return (
    <section className="file-support" aria-label="File support">
      <div className="support-table">
        <div className="support-column-headings" aria-hidden="true">
          <span>Format</span>
          <span>Extensions</span>
          <span>Analysis</span>
          <span />
        </div>
        {FILE_SUPPORT.map((item) => (
          <article key={item.family} className="support-item">
            <h3>{item.family}</h3>
            <code>{item.formats}</code>
            <div className="support-coverage">
              <span>{item.coverage}</span>
              <HelpHint label={`${item.family} coverage and limits`}>
                {item.detail}
              </HelpHint>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Explore ${item.family} tools`}
              onClick={() => explore(item.query)}
            >
              <ArrowUpRight size={14} /> Tools
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
