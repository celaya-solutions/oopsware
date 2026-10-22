/** Expected HTTP boundary failure, with a stable code and actionable message. */
export class WebFailure extends Error {
  readonly kind = "web_failure";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Read JSON from a provider without allowing HTML error pages into the UI. */
export const providerJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    throw new WebFailure(
      response.status === 401 ? 401 : 502,
      "provider_request_failed",
      `Provider returned HTTP ${response.status}. ${response.status === 401 ? "Reconnect this provider." : "Check the selected model and provider availability."}`,
    );
  }
  return response.json();
};
