/** Independently bound simultaneous work and provider request-start rate. */
export const DEFAULT_TRANSLATION_CONCURRENCY = 4;
export const DEFAULT_TRANSLATION_QPS = 2;

export function translationPerformance(concurrency: unknown, qps: unknown) {
  const integer = (value: unknown, fallback: number, maximum: number) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > maximum
    )
      throw new Error(`翻译性能参数必须是 1–${maximum} 的整数`);
    return value;
  };
  return {
    concurrency: integer(concurrency, DEFAULT_TRANSLATION_CONCURRENCY, 16),
    qps: integer(qps, DEFAULT_TRANSLATION_QPS, 10),
  };
}
