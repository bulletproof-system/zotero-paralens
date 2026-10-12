export type InstallStage =
  | "preparing"
  | "checking-uv"
  | "resolving"
  | "downloading"
  | "installing"
  | "verifying"
  | "completed";

export interface InstallProgress {
  percent: number;
  stage: InstallStage;
}

/** uv has no overall byte total. Percentages represent estimated milestones;
 * only the caller may mark 100% after verifying the installed imports. */
export class BackendInstallProgress {
  private percent = 0;
  constructor(private readonly report: (progress: InstallProgress) => void) {}

  advance(stage: InstallStage, percent: number): void {
    if (percent < this.percent) return;
    this.percent = percent;
    this.report({ stage, percent });
  }

  output(line: string): void {
    // eslint-disable-next-line no-control-regex -- Strip terminal ANSI escapes.
    const text = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    if (/^(?:Installed|Audited) \d+ packages?\b/i.test(text))
      this.advance("verifying", 95);
    else if (
      /^(?:Prepared \d+ packages?|Installing|Uninstalled \d+ packages?)\b/i.test(
        text,
      )
    )
      this.advance("installing", 85);
    else if (/^(?:Downloaded|Downloading|Building|Built)\b/i.test(text))
      this.advance("downloading", /^Downloaded\b/i.test(text) ? 65 : 40);
    else if (/^Resolved \d+ packages?\b/i.test(text))
      this.advance("downloading", 30);
  }
}
