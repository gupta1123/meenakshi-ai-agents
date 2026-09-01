export type DeliveryFailure = {
  message: string;
  retryable: boolean;
  statusCode?: number | null;
  providerResponse?: unknown;
};

export function retryAt(attemptNumber: number) {
  const delaySeconds = Math.min(15 * 2 ** Math.max(0, attemptNumber - 1), 15 * 60);
  return new Date(Date.now() + delaySeconds * 1_000).toISOString();
}

export function deliveryFailure(error: unknown): DeliveryFailure {
  if (error && typeof error === "object" && "retryable" in error) {
    const typed = error as { message?: unknown; retryable?: unknown; statusCode?: unknown; providerResponse?: unknown };
    return {
      message: typeof typed.message === "string" ? typed.message : "MSG91 delivery failed.",
      retryable: typed.retryable === true,
      statusCode: typeof typed.statusCode === "number" ? typed.statusCode : null,
      providerResponse: typed.providerResponse,
    };
  }
  return { message: error instanceof Error ? error.message : String(error ?? "MSG91 delivery failed."), retryable: true, statusCode: null };
}

export function isTerminalFailure(attemptNumber: number, maxAttempts: number, failure: DeliveryFailure) {
  return !failure.retryable || attemptNumber >= maxAttempts;
}
