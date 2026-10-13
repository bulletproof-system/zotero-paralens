import { TranslationJobProgress } from "./contracts";
import { workerStageLabel } from "./jobError";

/** Worker percentages stay monotonic; success is reported after attachment import. */
export function normalizeWorkerProgress(
  value: unknown,
  previous?: TranslationJobProgress,
): TranslationJobProgress {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const counter = (input: unknown) =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0
      ? input
      : undefined;
  const total = counter(record.total);
  const completed = counter(record.completed);
  const incoming =
    typeof record.percent === "number" && Number.isFinite(record.percent)
      ? Math.max(0, Math.min(97, record.percent))
      : undefined;
  return {
    stage: workerStageLabel(record.stage),
    completed:
      completed === undefined
        ? undefined
        : total === undefined
          ? completed
          : Math.min(completed, total),
    total,
    percent:
      incoming === undefined
        ? previous?.percent
        : Math.max(previous?.percent ?? 0, incoming),
  };
}
